// answerEngine.js (v6) — 유연 지식 + 학습 반영.
// 셀러 등록 정보 + '과거에 실제로 보낸 답변'을 함께 근거로 추천. 수정본을 학습하면 추천이 점점 그 셀러답게.

const { hasLLM, chatJSON, embed } = require("./llm");
const { store } = require("./store");

const SENSITIVE = ["효능","효과","부작용","복용","먹으면","치료","낫나요","질병","진단",
  "환불","취소","고소","소비자원","신고","변호사","계좌","주민번호","개인정보","주소 변경"];

function classify(t) {
  if (/(언제|며칠|출발|도착|배송|택배|발송|받아)/.test(t)) return "배송";
  if (/(재고|품절|입고|사이즈.*있|남았)/.test(t)) return "재고";
  if (/(교환|반품|환불|취소)/.test(t)) return "교환/환불";
  if (/(불량|하자|망가|파손|냄새|이상)/.test(t)) return "클레임";
  return "기타";
}
function overlap(a, b) {
  const set = new Set(String(b).replace(/[.,!?]/g, "").split(/\s+/));
  return String(a).split(/\s+/).filter((w) => w.length > 1 && set.has(w)).length;
}

const SYSTEM = (shop, tone) => [
  `너는 '${shop}'의 고객상담 담당자다. 말투는 ${tone === "polite" ? "정중하게" : "친근하고 정중하게"}.`,
  "아래 <참고자료>와 <과거답변 예시>에 근거해 한국어로 답한다. 근거에 없는 사실을 지어내지 않는다.",
  "<과거답변 예시>가 있으면 그 말투·표현을 최대한 따른다.",
  "답할 근거가 없거나 확신이 없으면 should_escalate=true 로 넘긴다.",
  '반드시 JSON만 출력: {"answer": string, "confidence": number(0~1), "should_escalate": boolean, "escalate_reason": string|null}',
].join("\n");

function buildUser({ context, examples, inquiry }) {
  let s = `<참고자료(이 가게가 등록한 정보)>\n${context || "(없음)"}\n</참고자료>`;
  if (examples && examples.length) {
    s += `\n\n<과거답변 예시(이 가게가 실제로 승인해 보낸 답 — 말투·내용을 최대한 따를 것)>\n`
      + examples.map((e) => `문의: ${e.inquiry}\n답변: ${e.text}`).join("\n---\n");
  }
  s += `\n\n<고객문의>\n${inquiry}\n</고객문의>`;
  return s;
}

async function draft({ sellerId = "demo-seller-1", inquiry, healthPreset = false }) {
  const category = classify(inquiry);

  // 1) 하드룰 넘김
  const hit = SENSITIVE.find((k) => inquiry.includes(k));
  if (category === "클레임" || (hit && (healthPreset || category !== "배송"))) {
    return { category, answer: "", confidence: 0, should_escalate: true,
      escalate_reason: category === "클레임" ? "클레임/분쟁 소지" : `민감 주제(${hit})`,
      used_sources: [], source: "escalate" };
  }

  // 2) 등록 지식 + 과거 승인답변(학습)
  const kb = await store.getSeller(sellerId);
  const knowledge = kb.knowledge || [];
  let examples = [];
  try { examples = await store.searchPast(sellerId, category, inquiry, null, 3); } catch (_) {}

  if (!knowledge.length && !examples.length) {
    return { category, answer: "", confidence: 0.3, should_escalate: true,
      escalate_reason: "등록된 정보 없음", used_sources: [], source: "none" };
  }
  const context = knowledge.map((k, i) => `${i + 1}) [${k.title}] ${k.body}`).join("\n");

  // 3) 생성
  let answer, confidence, should_escalate = false, escalate_reason = null;
  if (hasLLM()) {
    try {
      const out = await chatJSON({ system: SYSTEM(kb.shop, kb.tone), user: buildUser({ context, examples, inquiry }) });
      answer = out.answer || "";
      confidence = typeof out.confidence === "number" ? out.confidence : 0.7;
      should_escalate = !!out.should_escalate;
      escalate_reason = out.escalate_reason || null;
    } catch (e) {
      return { category, answer: "", confidence: 0, should_escalate: true, escalate_reason: "생성 오류", used_sources: [], source: "error" };
    }
  } else {
    if (examples.length) { answer = examples[0].text; confidence = 0.9; }
    else {
      const best = knowledge.map((k) => ({ k, s: overlap(inquiry, k.title + " " + k.body) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s > 0) { answer = `안녕하세요 고객님! ${best.k.body} 추가로 궁금한 점 있으면 편하게 말씀해 주세요.`; confidence = 0.75; }
      else { return { category, answer: "", confidence: 0.3, should_escalate: true, escalate_reason: "근거 없음", used_sources: [], source: "none" }; }
    }
  }

  const source = examples.length ? "learned" : "knowledge"; // learned = 과거답변 반영됨
  if (should_escalate || confidence < 0.6) {
    return { category, answer, confidence, should_escalate: true,
      escalate_reason: escalate_reason || "신뢰도 낮음", used_sources: [], source };
  }
  return { category, answer, confidence, should_escalate: false, escalate_reason: null,
    used_sources: examples.length ? ["knowledge", "past_answer"] : ["knowledge"], source };
}

// 학습: 셀러가 최종 전송(수정 포함)한 답변을 저장 → 다음 추천에 반영됨
async function recordFeedback({ sellerId = "demo-seller-1", inquiry, category, finalText, edited }) {
  if (!finalText || !finalText.trim()) return { ok: false };
  let emb = null;
  if (hasLLM()) { try { emb = (await embed([inquiry]))[0]; } catch (_) {} }
  const r = await store.addPast(sellerId, { inquiry, category: category || classify(inquiry), text: finalText.trim(), emb });
  return { ok: true, learned: !!edited, ...r };
}

module.exports = { draft, recordFeedback };
