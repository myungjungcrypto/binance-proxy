import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";

function isoTs() {
  return new Date().toISOString();
}

function sign({ ts, method, path, query = "", body = "", secret }) {
  const prehash = ts + method.toUpperCase() + path + (method.toUpperCase() === "GET" ? (query || "") : (body || ""));
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.OKX_API_KEY;
    const secret = process.env.OKX_SECRET_KEY;
    const passphrase = process.env.OKX_PASSPHRASE;
    if (!apiKey || !secret || !passphrase) {
      return res.status(500).json({ error: "Missing OKX API credentials" });
    }

    // Advanced + Multi-currency → 통합계정(UNIFIED)로 운용됨
    // 잔액: GET /api/v5/account/balance
    const method = "GET";
    const path = "/api/v5/account/balance";
    const query = ""; // 특정 ccy 필터 없으면 전체
    const ts = isoTs();
    const sig = sign({ ts, method, path, query, secret });

    const r = await fetch(`${OKX_BASE}${path}`, {
      method,
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": sig,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": passphrase
      }
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { return res.status(502).json({ error: "Non-JSON from OKX", raw: text }); }

    if (!r.ok || json.code !== "0") {
      return res.status(502).json({ error: "OKX API Error", data: json });
    }

    const data = json?.data?.[0];
    if (!data) return res.status(500).json({ error: "No account data", raw: json });

    // totalEq: 계정 총 평가 (USD 단위로 제공)
    const totalEq = Number(data.totalEq || "0");
    // 상세 코인별
    const details = Array.isArray(data.details) ? data.details : [];
    // 상위 5개(USD 가치 큰 순)
    const topCoins = details
      .map(c => ({ ccy: c.ccy, usd: Number(c.eqUsd || "0") }))
      .filter(x => x.usd && Number.isFinite(x.usd))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);

    return res.status(200).json({
      mode: "Advanced / Multi-Currency",
      totalUSD: Math.round(totalEq * 100) / 100,
      topCoinsUSD: topCoins,
      timestamp: Date.now()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}