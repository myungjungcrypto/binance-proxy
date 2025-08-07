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

    // 서명 함수
    const sign = (query) =>
      crypto.createHmac("sha256", secretKey).update(query).digest("hex");

    // 1. BTC 가격 조회 (BTC → USD 변환용)
    const priceRes = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
    );
    const priceData = await priceRes.json();
    const btcPrice = parseFloat(priceData.price);

    // 2. 전체 지갑 BTC 기준 잔액 조회
    const sig = sign(query);
    const balanceRes = await fetch(
      `https://api.binance.com/sapi/v1/asset/wallet/balance?${query}&signature=${sig}`,
      {
        headers: { "X-MBX-APIKEY": apiKey },
      }
    );

    const balanceData = await balanceRes.json();

    if (!Array.isArray(balanceData)) {
      return res.status(500).json({
        error: "Unexpected response format",
        debug: JSON.stringify(balanceData),
      });
    }

    let totalBTC = 0;
    const breakdown = [];

    balanceData.forEach((wallet) => {
      const btcVal = parseFloat(wallet.balance);
      if (btcVal > 0) {
        totalBTC += btcVal;
        breakdown.push({
          wallet: wallet.walletName,
          balance: wallet.balance,
        });
      }
    });

    const totalUSD = parseFloat((totalBTC * btcPrice).toFixed(2));

    res.status(200).json({
      totalUSD,
      breakdown,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}