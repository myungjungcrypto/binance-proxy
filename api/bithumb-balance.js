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

    // ⚠️ nonce는 중복 없이 증가해야 함
    const nonce = (Date.now().toString() + Math.floor(Math.random() * 1000)).toString();

    // ✅ body에 endpoint를 "맨 앞"에 배치
    const bodyParams = new URLSearchParams();
    bodyParams.append("endpoint", endpoint);   // 반드시 첫번째
    bodyParams.append("currency", "ALL");      // 전체 잔고 + total_krw
    const bodyStr = bodyParams.toString();     // endpoint=/info/balance&currency=ALL

    // ✅ 서명도 endpoint \0 bodyStr \0 nonce (BASE64)
    const toSign = `${endpoint}\0${bodyStr}\0${nonce}`;
    const signature = crypto.createHmac("sha512", secretKey)
      .update(toSign)
      .digest("base64");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Api-Client-Type": "2", // 환경에 따라 요구됨
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept": "application/json",
    };

    const resp = await fetch(url, { method: "POST", headers, body: bodyStr });
    const text = await resp.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "Non-JSON response", raw: text, sent: { bodyStr, toSign } });
    }

    if (json.status !== "0000") {
      // 디버깅을 위해 받은 값/보낸 값 같이 반환
      return res.status(500).json({ error: "Bithumb API Error", data: json, sent: { bodyStr, toSign } });
    }

    const krw = parseFloat(json.data?.total_krw || "0");
    return res.status(200).json({ totalKRW: krw, raw: json.data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}