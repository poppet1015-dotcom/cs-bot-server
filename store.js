// store.js — 저장소 추상화. DATABASE_URL 있으면 PostgreSQL+pgvector, 없으면 in-memory 폴백.
// getSeller(id): 답변용(shop/tone/knowledge). getKnowledge/setKnowledge: 관리 페이지용(자율 편집).

const hasDB = () => !!process.env.DATABASE_URL;

function overlap(a, b) {
  const set = new Set(String(b).replace(/[.,!?]/g, "").split(/\s+/));
  return String(a).split(/\s+/).filter((w) => w.length > 1 && set.has(w)).length;
}

// ---------- in-memory (DB 없을 때 폴백) ----------
const KB = {
  "demo-seller-1": {
    shop: "데모상점", tone: "friendly", apiKey: "demo-key-123",
    knowledge: [
      { title: "배송", body: "오후 3시 이전 결제 시 당일 출고, 보통 1~2일 내 도착(주말·공휴일 제외)." },
      { title: "교환/환불", body: "미착용·택 부착 시 수령 후 7일 이내 교환. 단순변심 왕복 배송비 6,000원." },
    ],
  },
};
const PAST = {};
const memStore = {
  async getSeller(id) {
    const s = KB[id];
    return s ? { shop: s.shop, tone: s.tone, knowledge: s.knowledge || [] }
             : { shop: "상점", tone: "friendly", knowledge: [] };
  },
  async getKnowledge(id) { return (KB[id]?.knowledge || []).map((k) => ({ title: k.title, body: k.body, type: "faq" })); },
  async setKnowledge(id, items) {
    if (!KB[id]) KB[id] = { shop: "상점", tone: "friendly", knowledge: [] };
    KB[id].knowledge = items.filter((it) => it.title && it.body).map((it) => ({ title: it.title, body: it.body }));
    return { ok: true, count: KB[id].knowledge.length };
  },
  async searchPast(id, cat, inquiry, emb, k = 3) {
    const arr = (PAST[id] || []).filter((p) => p.category === cat);
    return arr.map((p) => ({ p, s: overlap(inquiry, p.inquiry) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.p.ts - a.p.ts).slice(0, k).map((x) => x.p);
  },
  async addPast(id, r) { (PAST[id] || (PAST[id] = [])).push({ ...r, ts: Date.now() }); return { ok: true }; },
};

// ---------- PostgreSQL + pgvector ----------
let pool = null;
function pg() {
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}
const toVec = (emb) => (emb ? "[" + emb.join(",") + "]" : null);
const dbStore = {
  async getSeller(id) {
    const s = await pg().query("SELECT shop_name, tone FROM sellers WHERE id=$1", [id]);
    const k = await pg().query("SELECT title, body FROM knowledge_items WHERE seller_id=$1 ORDER BY id", [id]);
    const row = s.rows[0] || {};
    return { shop: row.shop_name || "상점", tone: row.tone || "friendly", knowledge: k.rows };
  },
  async getKnowledge(id) {
    const k = await pg().query("SELECT title, body, type FROM knowledge_items WHERE seller_id=$1 ORDER BY id", [id]);
    return k.rows;
  },
  async setKnowledge(id, items) {
    const client = pg();
    await client.query("DELETE FROM knowledge_items WHERE seller_id=$1", [id]);
    let n = 0;
    for (const it of items) {
      if (!it.title || !it.body) continue;
      await client.query("INSERT INTO knowledge_items (seller_id, type, title, body) VALUES ($1,$2,$3,$4)",
        [id, it.type || "faq", it.title, it.body]);
      n++;
    }
    return { ok: true, count: n };
  },
  async searchPast(id, cat, inquiry, emb, k = 3) {
    const q = await pg().query(
      `SELECT inquiry, text FROM past_answers WHERE seller_id=$1 AND category=$2 ORDER BY created_at DESC LIMIT $3`,
      [id, cat, k]);
    return q.rows;
  },
  async addPast(id, r) {
    await pg().query(
      `INSERT INTO past_answers (seller_id, inquiry, category, text, embedding) VALUES ($1,$2,$3,$4,$5::vector)`,
      [id, r.inquiry, r.category, r.text, toVec(r.emb)]);
    return { ok: true };
  },
};

// ---------- 지표 이벤트 + 집계 ----------
const EVENTS = [];
function computeStats(rows) {
  const drafts = rows.filter((r) => r.kind === "draft");
  const sends = rows.filter((r) => r.kind === "send");
  const nonEsc = drafts.filter((d) => !d.escalated);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const categories = {};
  drafts.forEach((d) => { if (d.category) categories[d.category] = (categories[d.category] || 0) + 1; });
  return {
    drafts: drafts.length, sends: sends.length,
    escalate_rate: pct(drafts.filter((d) => d.escalated).length, drafts.length),
    adopt_rate: pct(sends.filter((s) => !s.edited).length, sends.length),
    learned_rate: pct(nonEsc.filter((d) => d.source === "learned").length, nonEsc.length),
    categories,
  };
}
memStore.addEvent = async (sellerId, e) => { EVENTS.push({ seller_id: sellerId, ...e, ts: Date.now() }); };
memStore.getStats = async (sellerId) => computeStats(EVENTS.filter((e) => e.seller_id === sellerId));
dbStore.addEvent = async (sellerId, e) => {
  await pg().query(
    `INSERT INTO events (seller_id, kind, category, escalated, edited, source) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sellerId, e.kind, e.category || null, e.escalated ?? null, e.edited ?? null, e.source || null]);
};
dbStore.getStats = async (sellerId) => {
  const q = await pg().query(`SELECT kind, category, escalated, edited, source FROM events WHERE seller_id=$1`, [sellerId]);
  return computeStats(q.rows);
};

// ---------- 인증: API 키 → sellerId ----------
memStore.getSellerIdByKey = async (key) => {
  for (const [id, v] of Object.entries(KB)) if (v.apiKey === key) return id;
  return null;
};
dbStore.getSellerIdByKey = async (key) => {
  const q = await pg().query("SELECT id FROM sellers WHERE api_key=$1", [key]);
  return q.rows[0]?.id || null;
};

module.exports = { store: hasDB() ? dbStore : memStore, hasDB };
