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

    // 1. 포트폴리오 마진 / Unified Account 전체 USD 가치
    const sigPM = sign(query);
    const pmRes = await fetch(
      `https://fapi.binance.com/vapi/v1/account?${query}&signature=${sigPM}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    const pmData = await pmRes.json();

    if (!pmData.totalWalletBalance) {
      return res.status(400).json({
        error: "Failed to fetch total USD value",
        response: pmData
      });
    }

    const totalUSD = parseFloat(pmData.totalWalletBalance);

    // 2. Futures 알트코인 가치 (BTC, ETH, XRP 제외)
    const sigFutures = sign(query);
    const futuresRes = await fetch(
      `https://fapi.binance.com/fapi/v2/positionRisk?${query}&signature=${sigFutures}`,
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