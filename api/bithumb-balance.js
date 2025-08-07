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
    const params = new URLSearchParams({ currency: "KRW" }).toString();

    const strToSign = `${endpoint}\0${params}\0${nonce}`;
    const signature = crypto
      .createHmac("sha512", secretKey)
      .update(strToSign)
      .digest("base64");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: params,
    });

    const result = await response.json();

    if (result.status !== "0000") {
      return res.status(500).json({ error: "Bithumb API Error", data: result });
    }

    const krwBalance = parseFloat(result.data.total_krw);
    res.status(200).json({ totalKRW: krwBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}