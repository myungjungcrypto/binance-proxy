import crypto from "crypto";

function sign({ timestamp, method, requestPath, body, secretKey }) {
  const prehash = timestamp + method + requestPath + (body || "");
  return crypto.createHmac("sha256", secretKey).update(prehash).digest("base64");
}

async function okxFetch({ method = "GET", path, body = "", apiKey, secretKey, passphrase }) {
  const timestamp = new Date().toISOString();
  const signature = sign({ timestamp, method, requestPath: path, body, secretKey });

  const resp = await fetch(`https://www.okx.com${path}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
    },
    ...(method !== "GET" ? { body } : {}),
  });

  const json = await resp.json();
  if (json.code !== "0") {
    throw new Error(`OKX API Error ${json.code}: ${json.msg || ""}`);
  }
  return json;
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.OKX_API_KEY;
    const secretKey = process.env.OKX_SECRET_KEY;
    const passphrase = process.env.OKX_PASSPHRASE;
    if (!apiKey || !secretKey || !passphrase) {
      return res.status(500).json({ error: "Missing OKX API credentials" });
    }

    // 1) 계정 잔액(UA, 멀티커런시) — totalEq(USD) 신뢰
    const bal = await okxFetch({
      method: "GET",
      path: "/api/v5/account/balance",
      apiKey, secretKey, passphrase,
    });

    const info = bal?.data?.[0];
    if (!info) {
      return res.status(500).json({ error: "No account data", raw: bal });
    }

    // totalEq: Unified Account에서 USD기준 총자산
    const totalEqUSD = parseFloat(info.totalEq || "0");

    // 코인별 eqUsd가 있으면 브레이크다운 구성
    const breakdown = Array.isArray(info.details)
      ? info.details
          .map(c => ({
            coin: c.ccy,
            eq: parseFloat(c.eq || "0"),
            usd: parseFloat(c.eqUsd || "0"),
          }))
          .filter(x => (Number.isFinite(x.usd) && x.usd !== 0) || (Number.isFinite(x.eq) && x.eq !== 0))
          .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      : [];

    // 2) 자산 총평가(보강) — valuationCcy는 기본 USD
    const valuationCcy = (req.query.valuationCcy || "USD").toUpperCase();
    const val = await okxFetch({
      method: "GET",
      path: `/api/v5/asset/asset-valuation?ccy=${encodeURIComponent(valuationCcy)}`,
      apiKey, secretKey, passphrase,
    });
    const totalVal = parseFloat(val?.data?.[0]?.totalVal || "0");

    // 최종 totalUSD는 우선순위: totalEq -> asset-valuation
    const totalUSD = Number.isFinite(totalEqUSD) && totalEqUSD > 0
      ? totalEqUSD
      : (valuationCcy === "USD" && Number.isFinite(totalVal) ? totalVal : 0);

    res.status(200).json({
      mode: "UA-Advanced-MultiCurrency",
      totalUSD: Math.round(totalUSD * 100) / 100,
      source: Number.isFinite(totalEqUSD) && totalEqUSD > 0 ? "account.balance.totalEq" : "asset.valuation",
      valuationCcy,
      topCoinsUSD: breakdown
        .filter(x => Number.isFinite(x.usd) && x.usd > 0)
        .slice(0, 5)
        .map(({ coin, usd }) => ({ coin, usd: Math.round(usd * 100) / 100 })),
      timestamp: Date.now(),
      rawHints: {
        hasEqUsdPerCoin: Array.isArray(info.details) && info.details.some(d => d.eqUsd !== undefined),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}