import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing API credentials" });
    }

    // 서명 생성 함수
    const sign = (query) =>
      crypto.createHmac("sha256", secretKey).update(query).digest("hex");

    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;

    // 1. 전체 지갑 USD 가치
    const sig1 = sign(query);
    const assetsRes = await fetch(
      `https://api.binance.com/sapi/v3/asset/getUserAsset?${query}&signature=${sig1}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    const assets = await assetsRes.json();
    let totalUSD = 0;
    assets.forEach((a) => {
      totalUSD += parseFloat(a.usdValue);
    });

    // 2. Futures 알트코인 가치 (BTC, ETH, XRP 제외)
    const sig2 = sign(query);
    const futuresRes = await fetch(
      `https://fapi.binance.com/fapi/v2/positionRisk?${query}&signature=${sig2}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    const futuresData = await futuresRes.json();
    let altFuturesUSD = 0;
    futuresData.forEach((pos) => {
      if (parseFloat(pos.positionAmt) !== 0) {
        const symbol = pos.symbol;
        if (
          !symbol.startsWith("BTC") &&
          !symbol.startsWith("ETH") &&
          !symbol.startsWith("XRP")
        ) {
          altFuturesUSD +=
            Math.abs(parseFloat(pos.positionAmt) * parseFloat(pos.markPrice));
        }
      }
    });

    res.status(200).json({
      totalUSD: parseFloat(totalUSD.toFixed(2)),
      altFuturesUSD: parseFloat(altFuturesUSD.toFixed(2)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}