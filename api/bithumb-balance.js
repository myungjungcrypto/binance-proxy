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
    const nonce = Date.now().toString();

    // ✅ KRW → ALL 로 변경 (전체 잔고 + total_krw 포함)
    const params = new URLSearchParams({ currency: "ALL" }).toString();

    // v1 서명: endpoint \0 params \0 nonce 를 HMAC-SHA512 후 base64
    const strToSign = `${endpoint}\0${params}\0${nonce}`;
    const signature = crypto.createHmac("sha512", secretKey)
      .update(strToSign)
      .digest("base64");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Content-Type": "application/x-www-form-urlencoded",
      // 일부 환경에서 요구될 수 있는 헤더(문서/사례에 따라 다름)
      "Api-Client-Type": "2"
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: params,
    });

    const result = await response.json();

    if (result.status !== "0000") {
      // 디버깅을 위해 원문 그대로 보여주기
      return res.status(500).json({ error: "Bithumb API Error", data: result });
    }

    // result.data.total_krw 가 전체 원화 잔고
    const krwBalance = parseFloat(result.data.total_krw || "0");
    return res.status(200).json({ totalKRW: krwBalance, raw: result.data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}