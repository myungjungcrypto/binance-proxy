// pages/api/bybit-test.js
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BYBIT_API_KEY;
    const secretKey = process.env.BYBIT_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bybit API credentials" });
    }

    const endpoint = "/v5/user/query-api";
    const baseUrl = "https://api.bybit.com";
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const queryParams = ""; // 이 API는 파라미터 필요 없음

    const strToSign = timestamp + apiKey + recvWindow + queryParams;
    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(strToSign)
      .digest("hex");

    const url = `${baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-SIGN-TYPE": "2",
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });

    const data = await response.json();
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}