import crypto from "crypto";

export default async function handler(req, res) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_SECRET_KEY;

  if (!apiKey || !secretKey) {
    return res.status(500).json({ error: "Missing Binance API credentials" });
  }

  const sign = (query) =>
    crypto.createHmac("sha256", secretKey).update(query).digest("hex");

  const timestamp = Date.now();
  const baseUrl = "https://api.binance.com";

  const getSnapshot = async (type) => {
    const query = `type=${type}&timestamp=${timestamp}`;
    const signature = sign(query);
    const url = `${baseUrl}/sapi/v1/accountSnapshot?${query}&signature=${signature}`;

    const resp = await fetch(url, {
      headers: { "X-MBX-APIKEY": apiKey },
    });

    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      const balances = data?.snapshotVos?.[0]?.data?.totalAssetOfBtc;
      return parseFloat(balances) || 0;
    } catch {
      console.error("Failed to parse snapshot", { type, text });
      return 0;
    }
  };

  try {
    const spot = await getSnapshot("SPOT");
    const margin = await getSnapshot("MARGIN");
    const futures = await getSnapshot("FUTURES");

    // Binance는 자산을 BTC 기준으로 줌 → USD 환산 필요
    // 가장 간단히 BTCUSDT 시세 사용
    const tickerRes = await fetch(`${baseUrl}/api/v3/ticker/price?symbol=BTCUSDT`);
    const ticker = await tickerRes.json();
    const btcPrice = parseFloat(ticker.price);

    const totalUSD = (spot + margin + futures) * btcPrice;

    res.status(200).json({
      spotBTC: spot,
      marginBTC: margin,
      futuresBTC: futures,
      totalUSD: parseFloat(totalUSD.toFixed(2)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}