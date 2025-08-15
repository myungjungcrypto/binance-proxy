// api/binance-alt-summary.js
import crypto from "crypto";

const EXCLUDED = new Set(["BTC", "ETH", "USDT", "USDC"]); // 지갑 합산에서 제외(USDT/USDC, BTC/ETH 제외)
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
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally { clearTimeout(t); }
}
function toNum(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function baseAssetFromSymbol(symbol) { return symbol.replace(/(USDT|USDC|BUSD)$/,""); }
function pushUSD(map, asset, usd) {
  if (!asset || EXCLUDED.has(asset)) return;
  if (!Number.isFinite(usd) || usd <= 0) return;
  map.set(asset, (map.get(asset) || 0) + usd);
}

export default async function handler(req, res) {
  try {
    // ✅ 계정 선택 (acct=2면 BINANCE2_* 사용)
    const useAcct2 = (req.query?.acct === "2");
    const apiKey    = useAcct2 ? process.env.BINANCE2_API_KEY    : process.env.BINANCE_API_KEY;
    const secretKey = useAcct2 ? process.env.BINANCE2_SECRET_KEY : process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) return res.status(500).json({ error: "Missing Binance API credentials" });

    const headers = { "X-MBX-APIKEY": apiKey };
    const debugMode = (req.query?.debug === "1" || req.query?.debug === "true");
    const dbg = { steps: [] };

    // ----- 0) 스팟 가격 테이블 (USDT/USDC 마켓) -----
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

   // ===== 1) USDⓈ-M 선물 ALT 포지션(USDT 마켓, BTC/ETH 제외) =====
let altFuturesUSD = 0;
let altFuturesTop = [];

const recvWindow = 5000;
const mkQs = (extra={}) => new URLSearchParams({
  timestamp: String(Date.now()),
  recvWindow: String(recvWindow),
  ...extra
}).toString();

// FAPI → 실패시 PAPI
let posRes = await fetchJson(
  (() => { const qs = mkQs(); return `https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sign(secretKey, qs)}`; })(),
  { headers }
);
if (!posRes.ok) {
  const qs = mkQs();
  const url = `https://papi.binance.com/papi/v1/um/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
  const rp = await fetchJson(url, { headers });
  dbg.steps.push({ futuresFetch: { fapi: { status: posRes.status, textSample: posRes.text?.slice(0,120) }, papi: { status: rp.status, textSample: rp.text?.slice(0,120) } }});
  if (rp.ok) posRes = rp;
} else {
  dbg.steps.push({ futuresFetch: { fapi: { status: posRes.status, textSample: posRes.text?.slice(0,120) } }});
}

if (posRes.ok && Array.isArray(posRes.json)) {
  const QUOTES = ["USDT"]; // USDT 마켓만
  const FUTURES_EXCLUDED_BASE = new Set(["BTC", "ETH"]);

  const priceCache = new Map();
  async function getFuturesPrice(symbol) {
    if (priceCache.has(symbol)) return priceCache.get(symbol);
    const pr = await fetchJson(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { headers });
    const px = pr.ok ? Number(pr.json?.price) : 0;
    priceCache.set(symbol, px || 0);
    return px || 0;
  }

  for (const pos of posRes.json) {
    const amt = Number(pos?.positionAmt || 0);
    if (!amt) continue;

    const symbol = String(pos?.symbol || "");
    if (!QUOTES.some(q => symbol.endsWith(q))) continue;     // USDT만
    const base = baseAssetFromSymbol(symbol);
    if (FUTURES_EXCLUDED_BASE.has(base)) continue;           // BTC/ETH 제외

    // ✅ 부호 유지한 USD 계산
    let usd = 0;
    const notional = Number(pos?.notional);
    if (Number.isFinite(notional) && notional !== 0) {
      usd = notional; // 이미 부호 포함 (숏이면 음수)
    } else {
      const mark = Number(pos?.markPrice || 0);
      if (mark) {
        usd = amt * mark; // amt에 부호 포함
      } else {
        const px = await getFuturesPrice(symbol);
        if (px) usd = amt * px; // amt에 부호 포함
      }
    }
    if (!usd) continue;

    // 100달러 이상(절대값)만 표기/합산
    if (Math.abs(usd) >= MIN_USD) {
      altFuturesUSD += usd; // ✅ 순가치로 합산
      altFuturesTop.push({
        symbol, base,
        positionSide: pos.positionSide || "BOTH",
        positionAmt: Number(amt.toFixed(6)),
        notional: Number.isFinite(notional) ? Number(notional.toFixed(2)) : null,
        markPrice: pos?.markPrice ? Number(Number(pos.markPrice).toFixed(6)) : null,
        usd: Number(usd.toFixed(2)),         // 부호 유지
        direction: usd > 0 ? "LONG" : "SHORT"
      });
    }
  }

  // 정렬은 순가치 기준(롱 큰 순 → 숏은 아래로)
  altFuturesTop.sort((a, b) => b.usd - a.usd);
  altFuturesTop = altFuturesTop.slice(0, 25);
}

    // ===== 2) 지갑 ALT(Spot/Funding/Margin/Isolated + Simple Earn) =====
    const assetUSD = new Map();
    let usedPath = "getUserAsset";

    // 2-1) getUserAsset
    {
      const qs = mkQs({ needBtcValuation: "true" });
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
        // 2-2) Fallback 체인
        usedPath = "fallback";

        // Spot
        {
          const qs2 = mkQs();
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
        // Funding
        {
          const qs2 = mkQs();
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
        // Cross Margin
        {
          const qs2 = mkQs();
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
        // Isolated Margin
        {
          const qs2 = mkQs({ symbols: "all" });
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

    // 2-3) Simple Earn (Flexible/Locked) 포함
    async function addSimpleEarnPositions() {
      // Flexible
      try {
        const qs = mkQs();
        const url = `https://api.binance.com/sapi/v1/simple-earn/flexible/position?${qs}&signature=${sign(secretKey, qs)}`;
        const r = await fetchJson(url, { headers });
        dbg.steps.push({ simpleEarn_flexible_status: r.status, count: Array.isArray(r.json?.rows) ? r.json.rows.length : 0 });
        if (r.ok && r.json?.rows) {
          for (const it of r.json.rows) {
            const asset = it?.asset;
            if (!asset || EXCLUDED.has(asset)) continue;
            const total = toNum(it?.totalAmount);
            if (!total) continue;
            const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
            if (!px) continue;
            const usd = total * px;
            if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
          }
        }
      } catch {}
      // Locked
      try {
        const qs = mkQs();
        const url = `https://api.binance.com/sapi/v1/simple-earn/locked/position?${qs}&signature=${sign(secretKey, qs)}`;
        const r = await fetchJson(url, { headers });
        dbg.steps.push({ simpleEarn_locked_status: r.status, count: Array.isArray(r.json?.rows) ? r.json.rows.length : 0 });
        if (r.ok && r.json?.rows) {
          for (const it of r.json.rows) {
            const asset = it?.asset;
            if (!asset || EXCLUDED.has(asset)) continue;
            const total = toNum(it?.totalAmount);
            if (!total) continue;
            const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
            if (!px) continue;
            const usd = total * px;
            if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
          }
        }
      } catch {}
    }
    await addSimpleEarnPositions();

    // ----- 합계 -----
    let altWalletUSD = 0;
    let altWalletTop = [];
    for (const [asset, usd] of assetUSD.entries()) {
      altWalletUSD += usd;
      altWalletTop.push({ asset, usd: Number(usd.toFixed(2)) });
    }
    altWalletTop.sort((a, b) => b.usd - a.usd);
    altWalletTop = altWalletTop.slice(0, 25);

    const out = {
      account: useAcct2 ? "acct2" : "acct1",
      altWalletUSD: Number(altWalletUSD.toFixed(2)),     // 지갑(Spot/Funding/Margin/Isolated + Simple Earn)
      altWalletTop,
      altFuturesUSD: Number(altFuturesUSD.toFixed(2)),   // USDⓈ-M 알트 포지션
      altFuturesTop,
      altTotalUSD: Number((altWalletUSD + altFuturesUSD).toFixed(2)), // 총합
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      path: "computed",
      t: Date.now()
    };
    if (debugMode) out._debug = dbg;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}