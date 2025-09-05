import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "API key or secret not set" });
    }

    const timestamp = Date.now();
    const recvWindow = 60000;
    const query = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(query)
      .digest("hex");

    const url = `https://api.binance.com/sapi/v1/portfolio/account?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-MBX-APIKEY": apiKey,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Vercel Server)"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}