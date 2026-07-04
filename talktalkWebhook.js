// talktalkWebhook.js — 네이버 톡톡 챗봇 API 어댑터 (공식 스키마 반영).
// 수신:   { event, user, textContent:{ text, inputType }, options }
// 동기응답: { event:"send", textContent:{ text } }  또는 res.sendStatus(200)
// 보내기API(비동기): POST https://gw.talk.naver.com/chatbot/v1/event
//                    header Authorization: <보내기API 키>  body { event:"send", user, textContent:{text} }
// 상담원 전환은 Handover API(handover_v1.md) 사용 — 아래 TODO 참고.
// 라우트: POST /webhook/talktalk/:token  (셀러별 웹훅 토큰으로 테넌트 식별)
//
// 두뇌(answerEngine/store)는 그대로 재사용. '입구'만 톡톡 웹훅으로 교체.

const express = require("express");
const router = express.Router();
const { draft } = require("./answerEngine");
const { store } = require("./store");

const SEND_URL = process.env.TALKTALK_SEND_URL || "https://gw.talk.naver.com/chatbot/v1/event";

// 비동기 보내기(느린 생성/후속 메시지/상담원 전환 안내용).
// sendKey = 셀러 봇의 '보내기 API' 인증 키(세러별로 저장). Authorization은 raw 키(Bearer 아님).
async function sendMessage(sendKey, user, text) {
  if (!sendKey) return { skipped: true };
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", Authorization: sendKey },
    body: JSON.stringify({ event: "send", user, textContent: { text } }),
  });
  return { status: res.status };
}

// 동기 응답 헬퍼(공식 스키마)
const replyText = (res, text) => res.json({ event: "send", textContent: { text } });

router.post("/:token", async (req, res) => {
  try {
    // 1) 테넌트 식별(셀러별 웹훅 토큰). 운영에선 별도 토큰 + 톡톡 서명검증 권장.
    const sellerId = await store.getSellerIdByKey(req.params.token);
    if (!sellerId) return res.status(401).json({ error: "unknown webhook token" });

    const body = req.body || {};
    const { event, user } = body;

    if (event === "open") {
      return replyText(res, "안녕하세요! 배송·교환·재고 문의를 남겨주시면 바로 도와드릴게요.");
    }
    if (event !== "send") {
      return res.sendStatus(200); // friend/leave/echo 등은 무시
    }

    const inquiry = body.textContent && body.textContent.text ? body.textContent.text.trim() : "";
    if (!inquiry) return res.sendStatus(200);

    // 2) 두뇌 호출
    const r = await draft({ sellerId, inquiry });
    await store.addEvent(sellerId, { kind: "draft", category: r.category, escalated: r.should_escalate, source: r.source });

    // 3) 넘김 → 상담원 전환 안내(+ Handover), 아니면 봇 답변
    if (r.should_escalate || !r.answer) {
      // TODO: Handover API(handover_v1.md)로 실제 상담원 전환 트리거.
      //       예) 셀러 sendKey 로 handover 이벤트 전송 → 상담원이 이어받음.
      return replyText(res, "확인이 필요한 문의예요. 담당자가 곧 답변드리겠습니다. 잠시만 기다려 주세요!");
    }
    return replyText(res, r.answer);

    // (지연 주의) LLM 생성이 5초를 넘길 수 있으면:
    //   1) 먼저 res.sendStatus(200) 또는 "확인 중" 메시지로 즉시 응답
    //   2) 생성 완료 후 sendMessage(sellerSendKey, user, r.answer) 로 비동기 전송
  } catch (e) {
    return replyText(res, "죄송해요, 지금 자동 응대가 어려워 담당자에게 연결해 드릴게요.");
  }
});

module.exports = router;
