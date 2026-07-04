// answerEngine.js (v4) — 두뇌. 저장소(store.js: DB 또는 in-memory)를 통해 동작.
// 분류 → 넘김판정 → 과거 승인답변 검색(임베딩) → LLM 생성(few-shot) → 학습 저장.

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

const SYSTEM = (shop, tone) => [
  `너는 '${shop}'의 고객상담 담당자다. 말투는 ${tone === "polite" ? "정중하게" : "친근하고 정중하게"}.`,
  "아래 <정책>과 <참고답변>에만 근거해 한국어로 답한다. 근거에 없는 가격·배송일·정책을 지어내지 않는다.",
  "확신이 없거나 환불·분쟁·개인정보·건강효능 문의면 답하지 말고 should_escalate=true 로 넘긴다.",
  '반드시 JSON만 출력: {"answer": string, "confidence": number(0~1), "should_escalate": boolean, "escalate_reason": string|null}',
].join("\n");

function buildUser({ policyText, examples, inquiry }) {
  const ex = examples.map((e, i) => `${i + 1}) 문의: ${e.inquiry}\n   답변: ${e.text}`).join("\n") || "(없음)";
  return `<정책>\n${policyText || "(등록된 정책 없음)"}\n</정책>\n\n<참고답변(이 셀러가 승인한 과거 답변)>\n${ex}\n</참고답변>\n\n<고객문의>\n${inquiry}\n</고객문의>`;
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

  const kb = await store.getSeller(sellerId);
  const policyText = (kb.policy || {})[category] || "";

  // 2) 과거 승인답변 검색(임베딩)
  let inqEmb = null;
  if (hasLLM()) { try { inqEmb = (await embed([inquiry]))[0]; } catch (_) {} }
  const examples = await store.searchPast(sellerId, category, inquiry, inqEmb);

  if (!examples.length && !policyText) {
    return { category, answer: "", confidence: 0.3, should_escalate: true,
      escalate_reason: "답변 근거 없음", used_sources: [], source: "none" };
  }

  // 3) 생성 — LLM(있으면) / 템플릿(폴백)
  let answer, confidence, should_escalate = false, escalate_reason = null;
  if (hasLLM()) {
    try {
      const out = await chatJSON({ system: SYSTEM(kb.shop, kb.tone), user: buildUser({ policyText, examples, inquiry }) });
      answer = out.answer || "";
      confidence = typeof out.confidence === "number" ? out.confidence : 0.7;
      should_escalate = !!out.should_escalate;
      escalate_reason = out.escalate_reason || null;
    } catch (e) {
      return { category, answer: "", confidence: 0, should_escalate: true, escalate_reason: "생성 오류", used_sources: [], source: "error" };
    }
  } else {
    if (examples.length) { answer = examples[0].text; confidence = 0.9; }
    else { answer = `안녕하세요 고객님! ${policyText} 추가로 궁금한 점 있으시면 편하게 말씀해 주세요.`; confidence = 0.8; }
  }

  const source = examples.length ? "learned" : "policy";
  if (should_escalate || confidence < 0.6) {
    return { category, answer, confidence, should_escalate: true,
      escalate_reason: escalate_reason || "신뢰도 낮음", used_sources: [], source };
  }
  return { category, answer, confidence, should_escalate: false, escalate_reason: null,
    used_sources: source === "learned" ? ["past_answer"] : ["policy:" + category], source };
}

// --- 학습: 최종 전송 답변 저장(임베딩 포함) ---
async function recordFeedback({ sellerId = "demo-seller-1", inquiry, category, finalText, edited }) {
  if (!finalText || !finalText.trim()) return { ok: false };
  let emb = null;
  if (hasLLM()) { try { emb = (await embed([inquiry]))[0]; } catch (_) {} }
  const r = await store.addPast(sellerId, { inquiry, category: category || classify(inquiry), text: finalText.trim(), emb });
  return { ok: true, learned: !!edited, ...r };
}

module.exports = { draft, recordFeedback };
