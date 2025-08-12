import crypto from "crypto";

async function tryCall({ apiKey, secretKey, endpoint, bodyStr, mode }) {
  const url = `https://api.bithumb.com${endpoint}`;
  const nonce = (Date.now().toString() + Math.floor(Math.random() * 1000)).toString();

  // mode1: endpoint \0 body \0 nonce (BASE64)  ← 가장 흔히 통과
  // mode2: endpoint ; body ; nonce (BASE64)    ← 일부 사례에서 요구
  const toSign =
    mode === "mode1"
      ? `${endpoint}\0${bodyStr}\0${nonce}`
      : `${endpoint};${bodyStr};${nonce}`;

  const signature = crypto.createHmac("sha512", secretKey).update(toSign).digest("base64");

  const headers = {
    "Api-Key": apiKey,
    "Api-Sign": signature,
    "Api-Nonce": nonce,
    "Api-Client-Type": "2",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Accept: "application/json",
  };

  const resp = await fetch(url, { method: "POST", headers, body: bodyStr });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, mode, error: "Non-JSON", raw: text, sent: { bodyStr, toSign } };
  }
  if (json.status === "0000") {
    return { ok: true, mode, data: json, sent: { bodyStr, toSign } };
  }
  return { ok: false, mode, error: "API", data: json, sent: { bodyStr, toSign } };
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const secretKey = process.env.BITHUMB_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/balance";

    // ✅ 핵심: 인코딩하지 않은 원문 body 사용 (슬래시 그대로)
    const bodyStr = `endpoint=${endpoint}&currency=ALL`;

    // 1) null 구분자 방식 시도
    const r1 = await tryCall({ apiKey, secretKey, endpoint, bodyStr, mode: "mode1" });
    if (r1.ok) {
      const krw = parseFloat(r1.data?.data?.total_krw || "0");
      return res.status(200).json({ totalKRW: krw, mode: r1.mode, raw: r1.data, debug: r1.sent });
    }

    // 2) 세미콜론 구분자 방식 시도
    const r2 = await tryCall({ apiKey, secretKey, endpoint, bodyStr, mode: "mode2" });
    if (r2.ok) {
      const krw = parseFloat(r2.data?.data?.total_krw || "0");
      return res.status(200).json({ totalKRW: krw, mode: r2.mode, raw: r2.data, debug: r2.sent });
    }

    // 모두 실패 시 시도 내역 반환
    return res.status(500).json({ error: "Both strategies failed", attempts: [r1, r2] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}