// llm.js — LLM/임베딩 래퍼 (OpenAI 호환 엔드포인트).
// 환경변수로 provider 교체 가능. 키가 없으면 hasLLM()=false → 엔진이 템플릿으로 폴백.
//
//   LLM_API_KEY      (필수, 없으면 폴백)
//   LLM_BASE_URL     (기본 https://api.openai.com/v1)
//   LLM_CHAT_MODEL   (기본 gpt-4o-mini)
//   LLM_EMBED_MODEL  (기본 text-embedding-3-small)

const BASE = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const KEY = process.env.LLM_API_KEY || "";
const CHAT_MODEL = process.env.LLM_CHAT_MODEL || "gpt-4o-mini";
const EMBED_MODEL = process.env.LLM_EMBED_MODEL || "text-embedding-3-small";

function hasLLM() { return !!KEY; }

function headers() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
}

// JSON 응답을 강제하는 챗 호출
async function chatJSON({ system, user, temperature = 0.3 }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  const d = await res.json();
  const txt = d.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(txt); } catch { return { answer: txt, confidence: 0.5, should_escalate: false, escalate_reason: null }; }
}

// 텍스트 배열 → 임베딩 벡터 배열
async function embed(texts) {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return (d.data || []).map((x) => x.embedding);
}

module.exports = { hasLLM, chatJSON, embed };
