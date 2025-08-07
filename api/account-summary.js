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

    const sign = (query) =>
      crypto.createHmac("sha256", secretKey).update(query).digest("hex");

    const signature = sign(query);

    const response = await fetch(
      `https://api.binance.com/sapi/v1/portfolio/account?${query}&signature=${signature}`,
      {
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      }
    );

    const rawText = await response.text();

    // 디버깅용 응답 출력
    return res.status(200).json({
      debug: rawText,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}