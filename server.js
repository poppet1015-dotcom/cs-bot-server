// server.js (v5) — 인증(API 키) + 멀티테넌시. 클라이언트 sellerId를 신뢰하지 않고,
// Authorization: Bearer <key> 로 서버가 sellerId를 판별한다. 모든 데이터는 sellerId로 격리.
const express = require("express");
const cors = require("cors");
const { draft, recordFeedback } = require("./answerEngine");
const { store } = require("./store");

const app = express();
// CORS: 운영에선 ALLOWED_ORIGINS(쉼표구분)로 제한. 미설정 시(개발) 전체 허용.
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(ORIGINS.length ? { origin: ORIGINS } : {}));
app.use(express.json({ limit: "256kb" }));

// --- 인증 미들웨어 ---
async function auth(req, res, next) {
  const h = req.get("Authorization") || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : (req.query.key || "");
  const sellerId = key ? await store.getSellerIdByKey(key) : null;
  if (!sellerId) return res.status(401).json({ error: "유효한 API 키가 필요합니다" });
  req.sellerId = sellerId; // ← 이후 모든 로직은 이 값만 사용
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

// 네이버 톡톡 챗봇 웹훅(공식 마켓 경로). Bearer 인증 대신 경로 토큰으로 테넌트 식별.
// 주의: 운영에선 톡톡 서명 헤더 검증을 추가할 것.
app.use("/webhook/talktalk", require("./talktalkWebhook"));

app.get("/health", (_req, res) => res.json({ ok: true, llm: !!process.env.LLM_API_KEY, db: !!process.env.DATABASE_URL }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`answer engine (v5) on :${PORT} · LLM ${process.env.LLM_API_KEY ? "on" : "off"} · DB ${process.env.DATABASE_URL ? "on" : "off"}`));
