// api/binance-alt-summary.js
import crypto from "crypto";

const EXCLUDED = new Set(["BTC", "ETH", "USDT", "USDC"]); // 지갑(Spot 등)에서 제외
const MIN_USD = 100;

function sign(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}
async function fetchJson(url, init = {}, timeoutMs = 10000) {
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
function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function baseAssetFromSymbol(symbol) {
  return symbol.replace(/(USDT|USDC|BUSD)$/, "");
}
function pushUSD(map, asset, usd) {
  if (!asset || EXCLUDED.has(asset)) return;
  if (!Number.isFinite(usd) || usd <= 0) return;
  map.set(asset, (map.get(asset) || 0) + usd);
}
async function getServerTimeFapi() {
  const r = await fetchJson("https://fapi.binance.com/fapi/v1/time");
  return r.ok ? Number(r.json?.serverTime) || Date.now() : Date.now();
}
async function getServerTimePapi() {
  const r = await fetchJson("https://papi.binance.com/papi/v1/time");
  return r.ok ? Number(r.json?.serverTime) || Date.now() : Date.now();
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }
    const headers = { "X-MBX-APIKEY": apiKey };
    const debugMode = (req.query?.debug === "1" || req.query?.debug === "true");
    const wantQtyMode = (req.query?.mode === "qty"); // true면 수량 기준 합계 산출
    const ts = Date.now();
    const dbg = { steps: [] };

    // ---------- 0) Spot 가격표 (USDT/USDC) ----------
    const tickAll = await fetchJson("https://api.binance.com/api/v3/ticker/price");
    if (!tickAll.ok || !Array.isArray(tickAll.json)) {
      return res.status(502).json({ error: "Failed to fetch spot prices", detail: tickAll });
    }
    const priceUSDT = new Map();
    const priceUSDC = new Map();
    for (const it of tickAll.json) {
      const s = String(it.symbol || "");
      const p = toNum(it.price);
      if (!p) continue;
      if (s.endsWith("USDT")) priceUSDT.set(baseAssetFromSymbol(s), p);
      if (s.endsWith("USDC")) priceUSDC.set(baseAssetFromSymbol(s), p);
    }
    dbg.steps.push({ spotPricePairs: tickAll.json.length });

    // ---------- 1) 선물 USD‑M (ALT만) ----------
    // fapi → 실패 시 papi(UM) 폴백
    let altFuturesUSD = 0;
    let altFuturesTop = [];
    let altFuturesQty = 0; // mode=qty일 때 절대수량 합
    let futDbg = {};

    async function fetchFuturesPositions_FAPI() {
      const recvWindow = 5000;
      let serverTs = await getServerTimeFapi();
      let drift = serverTs - Date.now();
      const qs = new URLSearchParams({
        timestamp: String(Date.now() + drift),
        recvWindow: String(recvWindow),
      }).toString();
      const url = `https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
      return fetchJson(url, { headers });
    }
    async function fetchFuturesPositions_PAPI() {
      const recvWindow = 5000;
      let serverTs = await getServerTimePapi();
      let drift = serverTs - Date.now();
      const qs = new URLSearchParams({
        timestamp: String(Date.now() + drift),
        recvWindow: String(recvWindow),
      }).toString();
      const url = `https://papi.binance.com/papi/v1/um/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
      return fetchJson(url, { headers });
    }
    async function getFuturesPrice(symbol) {
      const pr = await fetchJson(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { headers });
      return pr.ok ? Number(pr.json?.price) || 0 : 0;
    }

    // 1차: FAPI
    let rF = await fetchFuturesPositions_FAPI();
    futDbg.fapi = { status: rF.status, textSample: rF.text ? String(rF.text).slice(0, 120) : undefined };

    // -2015 등 오류면 PAPI로 폴백
    let positions = null;
    if (rF.ok && Array.isArray(rF.json)) {
      positions = rF.json;
    } else {
      let rP = await fetchFuturesPositions_PAPI();
      futDbg.papi = { status: rP.status, textSample: rP.text ? String(rP.text).slice(0, 120) : undefined };
      if (rP.ok && Array.isArray(rP.json)) positions = rP.json;
    }
    dbg.steps.push({ futuresFetch: futDbg, count: Array.isArray(positions) ? positions.length : null });

    if (Array.isArray(positions)) {
      const QUOTES = ["USDT"]; // 요청대로 USDT 마켓만
      const FUTURES_EXCLUDED_BASE = new Set(["BTC", "ETH"]); // 알트만

      for (const pos of positions) {
        const amt = Number(pos?.positionAmt || pos?.positionAmt?.[0] || 0); // PAPI도 동일 필드명
        if (!amt) continue;

        const symbol = String(pos?.symbol || "");
        if (!QUOTES.some(q => symbol.endsWith(q))) continue;
        const base = baseAssetFromSymbol(symbol);
        if (FUTURES_EXCLUDED_BASE.has(base)) continue;

        if (wantQtyMode) {
          altFuturesQty += Math.abs(amt);
          if (Math.abs(amt) > 0) {
            altFuturesTop.push({
              symbol, base,
              positionSide: pos.positionSide || "BOTH",
              positionAmt: Number(amt.toFixed(6)),
            });
          }
        } else {
          // USD 가치 모드: notional → mark → ticker
          const notional = Number(pos?.notional || 0);
          let usd = Math.abs(notional);
          if (!usd) {
            const mark = Number(pos?.markPrice || 0);
            if (mark) usd = Math.abs(amt * mark);
          }
          if (!usd) {
            const px = await getFuturesPrice(symbol);
            if (px) usd = Math.abs(amt * px);
          }
          if (usd >= MIN_USD) {
            altFuturesUSD += usd;
            altFuturesTop.push({
              symbol, base,
              positionSide: pos.positionSide || "BOTH",
              positionAmt: Number(amt.toFixed(6)),
              notional: notional ? Number(notional.toFixed(2)) : null,
              markPrice: pos?.markPrice ? Number(Number(pos.markPrice).toFixed(6)) : null,
              usd: Number(usd.toFixed(2)),
            });
          }
        }
      }

      altFuturesTop.sort((a, b) =>
        wantQtyMode ? Math.abs(b.positionAmt) - Math.abs(a.positionAmt) : (b.usd || 0) - (a.usd || 0)
      );
      altFuturesTop = altFuturesTop.slice(0, 25);
    }

    // ---------- 2) 지갑 ALT USD ----------
    const assetUSD = new Map();
    let usedPath = "getUserAsset";
    {
      const qs = new URLSearchParams({ timestamp: String(ts), needBtcValuation: "true" }).toString();
      const url = `https://api.binance.com/sapi/v3/asset/getUserAsset?${qs}&signature=${sign(secretKey, qs)}`;
      const r = await fetchJson(url, { headers });
      dbg.steps.push({ getUserAsset_status: r.status });

      if (r.ok && Array.isArray(r.json)) {
        for (const it of r.json) {
          const asset = it?.asset;
          if (!asset || EXCLUDED.has(asset)) continue;
          const total = toNum(it?.free) + toNum(it?.locked);
          if (!total) continue;
          const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
          if (!px) continue;
          const usd = total * px;
          if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
        }
      } else {
        // Fallback들
        usedPath = "fallback";
        // capital
        {
          const qs2 = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url2 = `https://api.binance.com/sapi/v1/capital/config/getall?${qs2}&signature=${sign(secretKey, qs2)}`;
          const r2 = await fetchJson(url2, { headers });
          dbg.steps.push({ capital_status: r2.status, count: Array.isArray(r2.json) ? r2.json.length : 0 });
          if (r2.ok && Array.isArray(r2.json)) {
            for (const it of r2.json) {
              const asset = it?.coin;
              if (!asset || EXCLUDED.has(asset)) continue;
              const total = toNum(it?.free) + toNum(it?.locked);
              if (!total) continue;
              const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
              if (!px) continue;
              const usd = total * px;
              if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
            }
          }
        }
        // funding
        {
          const qs2 = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url2 = `https://api.binance.com/sapi/v1/asset/get-funding-asset?${qs2}&signature=${sign(secretKey, qs2)}`;
          const r2 = await fetchJson(url2, { method: "POST", headers });
          dbg.steps.push({ funding_status: r2.status, count: Array.isArray(r2.json) ? r2.json.length : 0 });
          if (r2.ok && Array.isArray(r2.json)) {
            for (const it of r2.json) {
              const asset = it?.asset;
              if (!asset || EXCLUDED.has(asset)) continue;
              const total = toNum(it?.free) + toNum(it?.locked) + toNum(it?.freeze);
              if (!total) continue;
              const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
              if (!px) continue;
              const usd = total * px;
              if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
            }
          }
        }
        // cross margin
        {
          const qs2 = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url2 = `https://api.binance.com/sapi/v1/margin/account?${qs2}&signature=${sign(secretKey, qs2)}`;
          const r2 = await fetchJson(url2, { headers });
          dbg.steps.push({ marginCross_status: r2.status, ok: r2.ok });
          if (r2.ok && r2.json?.userAssets && Array.isArray(r2.json.userAssets)) {
            for (const it of r2.json.userAssets) {
              const asset = it?.asset;
              if (!asset || EXCLUDED.has(asset)) continue;
              const total = toNum(it?.free) + toNum(it?.locked) + toNum(it?.borrowed) - toNum(it?.interest);
              if (total <= 0) continue;
              const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
              if (!px) continue;
              const usd = total * px;
              if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
            }
          }
        }
        // isolated margin
        {
          const qs2 = new URLSearchParams({ symbols: "all", timestamp: String(ts) }).toString();
          const url2 = `https://api.binance.com/sapi/v1/margin/isolated/account?${qs2}&signature=${sign(secretKey, qs2)}`;
          const r2 = await fetchJson(url2, { headers });
          dbg.steps.push({ marginIso_status: r2.status, ok: r2.ok });
          if (r2.ok && r2.json?.assets && Array.isArray(r2.json.assets)) {
            for (const pair of r2.json.assets) {
              for (const side of ["baseAsset", "quoteAsset"]) {
                const it = pair[side];
                const asset = it?.asset;
                if (!asset || EXCLUDED.has(asset)) continue;
                const total = toNum(it?.free) + toNum(it?.locked) + toNum(it?.borrowed) - toNum(it?.interest);
                if (total <= 0) continue;
                const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
                if (!px) continue;
                const usd = total * px;
                if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
              }
            }
          }
        }
      }
    }

    let altWalletUSD = 0;
    let altWalletTop = [];
    for (const [asset, usd] of assetUSD.entries()) {
      altWalletUSD += usd;
      altWalletTop.push({ asset, usd: Number(usd.toFixed(2)) });
    }
    altWalletTop.sort((a, b) => b.usd - a.usd);
    altWalletTop = altWalletTop.slice(0, 25);

    const out = {
      altWalletUSD: Number(altWalletUSD.toFixed(2)),
      altWalletTop,
      altFuturesUSD: wantQtyMode ? undefined : Number(altFuturesUSD.toFixed(2)),
      altFuturesTop,
      altFuturesQty: wantQtyMode ? Number(altFuturesQty.toFixed(6)) : undefined,
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      path: usedPath,
      t: Date.now(),
    };
    if (debugMode) out._debug = dbg;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}