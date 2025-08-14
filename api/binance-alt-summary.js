// api/binance-alt-summary.js
import crypto from "crypto";

const EXCLUDED = new Set(["BTC", "ETH", "USDT", "USDC"]);
const MIN_USD = 100;

// ---- helpers ----
function hmacSign(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}
async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}
function baseFromUSDT(symbol) {
  // e.g. ADAUSDT → ADA, ARBUSDC → ARB
  return symbol.replace(/(USDT|USDC|BUSD)$/, "");
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }

    const headers = { "X-MBX-APIKEY": apiKey };
    const ts = Date.now();
    const debug = req.query?.debug === "1" || req.query?.debug === "true";

    // 0) BTCUSDT 가격 (지갑 USD 환산용)
    let btcPrice = 0;
    {
      // Spot public ticker (가장 무난)
      const r = await fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
      const p = Number(r?.json?.price);
      if (r.ok && Number.isFinite(p) && p > 0) btcPrice = p;
      if (!btcPrice) {
        return res.status(502).json({ error: "Failed to fetch BTCUSDT price", detail: r });
      }
    }

    // 1) 지갑 자산: /sapi/v3/asset/getUserAsset?needBtcValuation=true
    let altWalletUSD = 0;
    let altWalletTop = [];
    let walletRaw = null;
    {
      const qs = new URLSearchParams({ timestamp: String(ts), needBtcValuation: "true" }).toString();
      const sig = hmacSign(secretKey, qs);
      const url = `https://api.binance.com/sapi/v3/asset/getUserAsset?${qs}&signature=${sig}`;
      const r = await fetchJson(url, { method: "GET", headers });
      walletRaw = r.json;

      if (!r.ok || !Array.isArray(r.json)) {
        if (debug) return res.status(200).json({ altWalletUSD: 0, altWalletTop: [], reason: "wallet-failed", response: r });
        throw new Error("Wallet API failed");
      }

      for (const it of r.json) {
        const asset = it?.asset;
        if (!asset || EXCLUDED.has(asset)) continue;

        const free = Number(it?.free || 0);
        const locked = Number(it?.locked || 0);
        const total = free + locked;

        // USD 환산: btcValuation * BTCUSDT
        const btcVal = Number(it?.btcValuation || 0);
        const usd = btcVal * btcPrice;

        if (usd >= MIN_USD && total > 0) {
          altWalletUSD += usd;
          altWalletTop.push({
            asset,
            free: Number(free.toFixed(8)),
            locked: Number(locked.toFixed(8)),
            usd: Number(usd.toFixed(2)),
          });
        }
      }

      // 큰 금액 순 정렬, 상위 25개만
      altWalletTop.sort((a, b) => b.usd - a.usd);
      altWalletTop = altWalletTop.slice(0, 25);
    }

    // 2) USD-M 선물 포지션: /fapi/v2/positionRisk
    let altFuturesUSD = 0;
    let altFuturesTop = [];
    let futuresRaw = null;
    {
      const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
      const sig = hmacSign(secretKey, qs);
      const url = `https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sig}`;
      const r = await fetchJson(url, { headers });
      futuresRaw = r.json;

      if (!r.ok || !Array.isArray(r.json)) {
        if (debug) return res.status(200).json({ altWalletUSD, altWalletTop, altFuturesUSD: 0, altFuturesTop: [], reason: "futures-failed", response: r });
        throw new Error("Futures API failed");
      }

      for (const pos of r.json) {
        const amt = Number(pos?.positionAmt || 0);
        if (!amt) continue;

        const symbol = String(pos?.symbol || "");
        const base = baseFromUSDT(symbol);
        // BTC, ETH, USDT, USDC 제외
        if (!symbol.endsWith("USDT") && !symbol.endsWith("USDC")) continue;
        if (EXCLUDED.has(base)) continue;

        const mark = Number(pos?.markPrice || 0);
        if (!mark) continue;

        const usd = Math.abs(amt * mark);
        if (usd >= MIN_USD) {
          altFuturesUSD += usd;
          altFuturesTop.push({
            symbol,
            base,
            positionAmt: Number(amt.toFixed(6)),
            markPrice: Number(mark.toFixed(6)),
            usd: Number(usd.toFixed(2)),
          });
        }
      }

      altFuturesTop.sort((a, b) => b.usd - a.usd);
      altFuturesTop = altFuturesTop.slice(0, 25);
    }

    const out = {
      altWalletUSD: Number(altWalletUSD.toFixed(2)),
      altWalletTop,
      altFuturesUSD: Number(altFuturesUSD.toFixed(2)),
      altFuturesTop,
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      t: Date.now(),
    };

    if (debug) {
      out._debug = {
        btcUSDT: btcPrice,
        walletCount: Array.isArray(walletRaw) ? walletRaw.length : 0,
        futuresCount: Array.isArray(futuresRaw) ? futuresRaw.length : 0,
      };
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}