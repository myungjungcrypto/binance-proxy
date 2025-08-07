import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const apiSecret = process.env.BITHUMB_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/balance";
    const url = `https://api.bithumb.com${endpoint}`;
    const nonce = Date.now().toString();

    const body = `endpoint=${endpoint}&currency=KRW`;

    const hmac = crypto.createHmac("sha512", apiSecret);
    const signature = hmac.update(Buffer.from(body)).digest("hex");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    const data = await response.json();

    if (data.status !== "0000") {
      return res.status(500).json({ error: "Bithumb API Error", data });
    }

    const totalKRW = parseFloat(data.data.total_krw);

    return res.status(200).json({
      totalKRW,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
