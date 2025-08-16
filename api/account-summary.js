// api/account-summary.js
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    // ✅ 계정 선택 (acct=2면 BINANCE2_* 사용)
    const useAcct2 = (req.query?.acct === '2');
    const apiKey    = useAcct2 ? process.env.BINANCE2_API_KEY    : process.env.BINANCE_API_KEY;
    const secretKey = useAcct2 ? process.env.BINANCE2_SECRET_KEY : process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing API credentials" });
    }

    // 서명 함수
    const sign = (query) =>
      crypto.createHmac("sha256", secretKey).update(query).digest("hex");

    // 1) BTCUSDT 가격 (USD 환산용)
    const priceResp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    const priceText = await priceResp.text();
    let btcPrice = 0;
    try {
      const priceJson = JSON.parse(priceText);
      btcPrice = Number(priceJson?.price) || 0;
    } catch (_) {}
    if (!btcPrice) {
      return res.status(502).json({ error: "Failed to fetch BTCUSDT price", raw: priceText });
    }

    // 2) 전체 지갑 BTC 기준 잔액
    const timestamp = Date.now();
    const qs = new URLSearchParams({ timestamp: String(timestamp) }).toString();
    const sig = sign(qs);

    const balResp = await fetch(
      `https://api.binance.com/sapi/v1/asset/wallet/balance?${qs}&signature=${sig}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );

    const balText = await balResp.text();
    let balJson = null;
    try {
      balJson = JSON.parse(balText);
    } catch {
      // HTML(403 등)로 올 때 대비
      return res.status(502).json({ error: "Binance returned non-JSON", raw: balText });
    }

    if (!Array.isArray(balJson)) {
      return res.status(502).json({ error: "Unexpected response format", data: balJson });
    }

    let totalBTC = 0;
    const breakdown = [];
    for (const w of balJson) {
      const v = Number(w?.balance) || 0;
  
        totalBTC += v;
        breakdown.push({ wallet: w.walletName, balance: w.balance });

    }

    const totalUSD = Number((totalBTC * btcPrice).toFixed(2));

    return res.status(200).json({
      totalUSD,
      btcPrice,
      totalBTC,
      breakdown,
      account: useAcct2 ? "acct2" : "acct1",
      t: Date.now()
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}