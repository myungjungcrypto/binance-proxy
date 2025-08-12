import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const secretKey = process.env.BITHUMB_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/balance";
    const url = `https://api.bithumb.com${endpoint}`;

    // nonce는 절대 중복되면 안 됨 (동시요청 대비 랜덤 붙임)
    const nonce = (Date.now().toString() + Math.floor(Math.random() * 1000)).toString();

    // ✅ body에도 endpoint 포함 (가장 호환성 좋은 방식)
    const bodyParams = new URLSearchParams({
      endpoint,         // <- 중요
      currency: "ALL",  // 전체 잔고 + total_krw 포함
    }).toString();

    // ✅ v1 서명: endpoint \0 bodyParams \0 nonce 를 HMAC-SHA512 후 BASE64
    const toSign = `${endpoint}\0${bodyParams}\0${nonce}`;
    const signature = crypto
      .createHmac("sha512", secretKey)
      .update(toSign)
      .digest("base64");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Api-Client-Type": "2", // 일부 환경에서 요구됨(없어도 되지만 넣는 걸 권장)
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyParams, // 서명에 쓴 body와 정확히 동일해야 함
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "Non-JSON response from Bithumb", raw: text });
    }

    if (result.status !== "0000") {
      // 디버깅 편의: 원문 그대로 반환
      return res.status(500).json({ error: "Bithumb API Error", data: result });
    }

    const krw = parseFloat(result.data.total_krw || "0");
    return res.status(200).json({ totalKRW: krw, raw: result.data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}