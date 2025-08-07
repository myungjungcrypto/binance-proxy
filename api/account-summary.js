import crypto from "crypto";

export default async function handler(req, res) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_SECRET_KEY;

  if (!apiKey || !secretKey) {
    return res.status(500).json({ error: "Missing Binance API credentials" });
  }

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(query)
    .digest("hex");

  const url = `https://api.binance.com/sapi/v1/asset/wallet/balance?${query}&signature=${signature}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
    });

    const text = await response.text();

    let balances;
    try {
      balances = JSON.parse(text);
    } catch (err) {
      return res.status(500).json({
        error: "Binance returned non-JSON response",
        raw: text,
      });
    }

    if (!Array.isArray(balances)) {
      return res.status(500).json({
        error: "Unexpected Binance response format",
        raw: balances,
      });
    }

    // 총 USD 잔고 계산
    const totalUSD = balances.reduce((sum, wallet) => {
      if (wallet.activate && wallet.balance) {
        return sum + parseFloat(wallet.balance);
      }
      return sum;
    }, 0);

    res.status(200).json({
      totalUSD: parseFloat(totalUSD.toFixed(2)),
      breakdown: balances
        .filter((wallet) => parseFloat(wallet.balance) > 0)
        .map((wallet) => ({
          wallet: wallet.walletName,
          balance: wallet.balance,
        })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}