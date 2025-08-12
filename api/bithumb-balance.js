import crypto from "crypto";

async function callBithumb({ apiKey, secretKey, endpoint, paramsObj, mode }) {
  const url = `https://api.bithumb.com${endpoint}`;
  const nonce = Date.now().toString();

  // mode A: body에 endpoint 넣지 않음, SIGN = endpoint \0 (params) \0 nonce, base64
  // mode B: body에 endpoint 포함,  SIGN = endpoint \0 (paramsWithEndpoint) \0 nonce, base64
  // mode C: body에 endpoint 넣지 않음, SIGN = endpoint \0 (params) \0 nonce, **hex**
  const params = new URLSearchParams(paramsObj).toString();
  const paramsWithEndpoint = new URLSearchParams({ ...paramsObj, endpoint }).toString();

  let body, toSign, signEncoding;
  if (mode === "A") {
    body = params;
    toSign = `${endpoint}\0${params}\0${nonce}`;
    signEncoding = "base64";
  } else if (mode === "B") {
    body = paramsWithEndpoint;
    toSign = `${endpoint}\0${paramsWithEndpoint}\0${nonce}`;
    signEncoding = "base64";
  } else {
    // mode C
    body = params;
    toSign = `${endpoint}\0${params}\0${nonce}`;
    signEncoding = "hex";
  }

  const signature = crypto.createHmac("sha512", secretKey).update(toSign).digest(signEncoding);

  const headers = {
    "Api-Key": apiKey,
    "Api-Sign": signature,
    "Api-Nonce": nonce,
    "Api-Client-Type": "2",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "Mozilla/5.0",
  };

  const resp = await fetch(url, { method: "POST", headers, body });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, mode, error: "Non-JSON", raw: text, sent: { body, toSign, signEncoding } };
  }
  if (json.status === "0000") {
    return { ok: true, mode, data: json, sent: { body, toSign, signEncoding } };
  }
  return { ok: false, mode, error: "API", data: json, sent: { body, toSign, signEncoding } };
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const secretKey = process.env.BITHUMB_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/balance";
    // ✅ 전체 잔고(원화 포함)를 위해 currency=ALL
    const paramsObj = { currency: "ALL" };

    const attempts = [];
    for (const mode of ["A", "B", "C"]) {
      // 순차 시도
      // A: (일반적으로 가장 많이 통과)
      // B: 일부 환경에서 요구
      // C: 드물게 hex 요구 사례(레거시) 대응
      // eslint-disable-next-line no-await-in-loop
      const r = await callBithumb({ apiKey, secretKey, endpoint, paramsObj, mode });
      attempts.push(r);
      if (r.ok) {
        // 성공 시, total_krw만 추출해서 요약 + 진단정보 함께 반환
        const krw = parseFloat(r.data?.data?.total_krw || "0");
        return res.status(200).json({
          totalKRW: krw,
          mode: r.mode,
          raw: r.data,
          // 디버깅에 도움(원치 않으면 제거 가능)
          debug: r.sent,
        });
      }
      // 5100이면 다음 전략으로 진행
    }

    // 모두 실패하면, 시도 결과를 그대로 보여줌
    return res.status(500).json({ error: "All strategies failed", attempts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}