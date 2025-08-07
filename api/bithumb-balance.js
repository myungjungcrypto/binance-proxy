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
    const currency = "BTC"; // 최소 하나 지정해야 함

    const nonce = Date.now().toString();
    const params = { currency };
    const encodedParams = new URLSearchParams(params).toString();
    const strToSign = `${endpoint}\0${encodedParams}\0${nonce}`;

    const signature = crypto
      .createHmac("sha512", secretKey)
      .update(strToSign)
      .digest("hex");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(params),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "Non-JSON response from Bithumb", raw: text });
    }

    if (data.status !== "0000") {
      return res.status(400).json({ error: "Bithumb API Error", data });
    }

    const krwBalance = parseFloat(data.data.total_krw) || 0;

    return res.status(200).json({
      krwBalance,
      breakdown: data.data,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}