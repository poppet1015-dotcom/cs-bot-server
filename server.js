// server.js (v6) — 답변 엔진 백엔드. /draft·/feedback·/stats + /webhook/talktalk + /admin/knowledge(자율 편집).
const express = require("express");
const cors = require("cors");
const { draft, recordFeedback } = require("./answerEngine");
const { store } = require("./store");

const app = express();
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(ORIGINS.length ? { origin: ORIGINS } : {}));
app.use(express.json({ limit: "512kb" }));

// --- 인증: Authorization: Bearer <API키> → req.sellerId ---
async function auth(req, res, next) {
  const h = req.get("Authorization") || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : (req.query.key || "");
  const sellerId = key ? await store.getSellerIdByKey(key) : null;
  if (!sellerId) return res.status(401).json({ error: "유효한 API 키가 필요합니다" });
  req.sellerId = sellerId;
  next();
}

app.post("/draft", auth, async (req, res) => {
  try {
    const { inquiry, healthPreset = false } = req.body || {};
    if (!inquiry || !inquiry.trim()) return res.status(400).json({ error: "inquiry 필요" });
    const result = await draft({ sellerId: req.sellerId, inquiry: inquiry.trim(), healthPreset });
    await store.addEvent(req.sellerId, { kind: "draft", category: result.category, escalated: result.should_escalate, source: result.source });
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/feedback", auth, async (req, res) => {
  try {
    const { inquiry, category, finalText, edited } = req.body || {};
    const r = await recordFeedback({ sellerId: req.sellerId, inquiry, category, finalText, edited });
    await store.addEvent(req.sellerId, { kind: "send", category, edited: !!edited });
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/stats", auth, async (req, res) => {
  try { res.json(await store.getStats(req.sellerId)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// --- 관리 페이지: 정책·질문 자율 편집 (즉시 반영) ---
app.get("/admin/knowledge", auth, async (req, res) => {
  try {
    const kb = await store.getSeller(req.sellerId);
    const items = await store.getKnowledge(req.sellerId);
    res.json({ shop: kb.shop, tone: kb.tone, items });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/admin/knowledge", auth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const r = await store.setKnowledge(req.sellerId, items);
    res.json(r); // 저장 즉시 봇이 새 내용으로 답함
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// --- 네이버 톡톡 챗봇 웹훅 ---
app.use("/webhook/talktalk", require("./talktalkWebhook"));

app.get("/health", (_req, res) => res.json({ ok: true, llm: !!process.env.LLM_API_KEY, db: !!process.env.DATABASE_URL }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`answer engine (v6) on :${PORT} · LLM ${process.env.LLM_API_KEY ? "on" : "off"} · DB ${process.env.DATABASE_URL ? "on" : "off"}`));
