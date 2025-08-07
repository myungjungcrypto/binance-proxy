import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing API credentials" });
    }

    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(query)
      .digest("hex");

    const url = `https://api.binance.com/sapi/v1/portfolio/account?${query}&signature=${signature}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({
        error: "Binance returned non-JSON response",
        raw: text,
      });
    }

    const totalUSD = parseFloat(data.totalNetAssetOfBtc) * parseFloat(data.markPriceBtc || 0);

    res.status(200).json({
      totalNetAssetOfBtc: data.totalNetAssetOfBtc,
      totalUSD: totalUSD.toFixed(2),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}