import crypto from "crypto";

function sign({ timestamp, apiKey, recvWindow, queryString, secretKey }) {
  const toSign = timestamp + apiKey + recvWindow + (queryString || "");
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BYBIT_API_KEY;
    const secretKey = process.env.BYBIT_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bybit API credentials" });
    }

    // 기본 UNIFIED(UTA). 필요 시 ?accountType=SPOT 로 호출 가능
    const accountType = (req.query.accountType || "UNIFIED").toUpperCase();
    const endpoint = "/v5/account/wallet-balance";
    const baseUrl = "https://api.bybit.com";
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const queryString = `accountType=${accountType}`;
    const signature = sign({ timestamp, apiKey, recvWindow, queryString, secretKey });

    const url = `${baseUrl}${endpoint}?${queryString}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-SIGN-TYPE": "2",
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });

    const json = await resp.json();
    if (json.retCode !== 0) {
      return res.status(500).json({ error: "Bybit API Error", data: json });
    }

    const info = json?.result?.list?.[0];
    if (!info) {
      return res.status(500).json({ error: "No account data", raw: json });
    }

    // 1) 공식 필드 사용 (권장)
    const totalEquity = parseFloat(info.totalEquity || "0");                // 총자산(USD)
    const totalWalletUSD = parseFloat(info.totalWalletBalance || "0");      // 지갑 잔액(USD)
    const totalAvailableUSD = parseFloat(info.totalAvailableBalance || "0");// 가용(USD)

    // 2) 백업 계산: 코인별 usdValue 합계
    let sumCoinUSD = 0;
    if (Array.isArray(info.coin)) {
      for (const c of info.coin) {
        const v = parseFloat(c.usdValue || "0");
        if (!Number.isNaN(v)) sumCoinUSD += v;
      }
    }

    // 최종 리턴: totalEquity가 존재하면 그걸 신뢰, 없으면 합계로 대체
    const totalUSD = Number.isFinite(totalEquity) && totalEquity > 0 ? totalEquity : sumCoinUSD;

    // 상위 코인 5개만 간단 브레이크다운(USD 기준)
    const breakdown =
      Array.isArray(info.coin)
        ? info.coin
            .map(c => ({ coin: c.coin, usd: parseFloat(c.usdValue || "0") }))
            .filter(x => x.usd && x.usd !== 0)
            .sort((a, b) => b.usd - a.usd)
            .slice(0, 5)
        : [];

    return res.status(200).json({
      accountType,
      totalUSD: Math.round(totalUSD * 100) / 100,
      walletUSD: Math.round(totalWalletUSD * 100) / 100,
      availableUSD: Math.round(totalAvailableUSD * 100) / 100,
      method: (totalEquity && totalEquity > 0) ? "totalEquity" : "sumCoinUSD",
      topCoinsUSD: breakdown,
      timestamp: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}