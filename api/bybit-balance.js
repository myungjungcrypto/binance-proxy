import crypto from "crypto";

function sign({ timestamp, apiKey, recvWindow, queryString, secretKey }) {
  const toSign = timestamp + apiKey + recvWindow + (queryString || "");
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BYBIT_API_KEY;
    const secretKey = process.env.BYBIT_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bybit API credentials" });
    }

    // 기본은 UNIFIED(UTA). 필요시 /api/bybit-balance?accountType=SPOT 로 호출 가능
    const accountType = (req.query.accountType || "UNIFIED").toUpperCase();
    const endpoint = "/v5/account/wallet-balance";
    const baseUrl = "https://api.bybit.com";
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const queryString = `accountType=${accountType}`;

    const signature = sign({ timestamp, apiKey, recvWindow, queryString, secretKey });
    const url = `${baseUrl}${endpoint}?${queryString}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-SIGN-TYPE": "2",
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });

    const data = await resp.json();
    if (data.retCode !== 0) {
      return res.status(500).json({ error: "Bybit API Error", data });
    }

    // 그대로(raw) 반환: 결과 구조 확인용
    return res.status(200).json({ success: true, accountType, raw: data.result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}