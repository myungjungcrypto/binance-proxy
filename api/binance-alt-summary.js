// api/binance-alt-summary.js
import crypto from "crypto";

const EXCLUDED = new Set(["BTC", "ETH", "USDT", "USDC"]); // 지갑 계산에서 제외(USDT/USDC 자체 잔고 제외)
const MIN_USD = 100;

// ---------- utils ----------
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
  // e.g. ADAUSDT -> ADA, ARBUSDC -> ARB
  return symbol.replace(/(USDT|USDC|BUSD)$/,"");
}
function pushUSD(map, asset, usd) {
  if (!asset || EXCLUDED.has(asset)) return;        // USDT/USDC/ BTC/ETH 제외
  if (!Number.isFinite(usd) || usd <= 0) return;
  map.set(asset, (map.get(asset) || 0) + usd);
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
    const ts0 = Date.now();
    const dbg = { steps: [] };

    // ----- 0) 스팟 가격 테이블 (USDT/USDC 마켓) -----
    const tickAll = await fetchJson("https://api.binance.com/api/v3/ticker/price");
    if (!tickAll.ok || !Array.isArray(tickAll.json)) {
      return res.status(502).json({ error: "Failed to fetch spot prices", detail: tickAll });
    }
    const priceUSDT = new Map(); // BASE -> price in USDT
    const priceUSDC = new Map(); // BASE -> price in USDC
    for (const it of tickAll.json) {
      const s = String(it.symbol || "");
      const p = toNum(it.price);
      if (!p) continue;
      if (s.endsWith("USDT")) priceUSDT.set(baseAssetFromSymbol(s), p);
      if (s.endsWith("USDC")) priceUSDC.set(baseAssetFromSymbol(s), p);
    }
    dbg.steps.push({ spotPricePairs: tickAll.json.length });

    // ===== 1) 선물 USD-M 포지션 합계 (ALT만: BTC/ETH 제외, USDT 마켓) =====
    let altFuturesUSD = 0;
    let altFuturesTop = [];

    async function getServerTimeFapi() {
      const r = await fetchJson("https://fapi.binance.com/fapi/v1/time");
      return r.ok ? Number(r.json?.serverTime) || Date.now() : Date.now();
    }
    {
      const recvWindow = 5000;
      const localTs = Date.now();
      let serverTs = await getServerTimeFapi();
      let drift = serverTs - localTs;

      async function fetchPositions(tsOverride) {
        const ts = (tsOverride ?? Date.now()) + drift;
        const qs = new URLSearchParams({
          timestamp: String(ts),
          recvWindow: String(recvWindow),
        }).toString();
        const url = `https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
        return fetchJson(url, { headers });
      }

      let r = await fetchPositions();
      if (!r.ok) {
        serverTs = await getServerTimeFapi();
        drift = serverTs - Date.now();
        r = await fetchPositions();
      }

      // 필요 시 대안: 포트폴리오/Unified 계정은 PAPI에서 포지션을 제공하기도 함
      if (!r.ok) {
        const qs = new URLSearchParams({ timestamp: String(Date.now()) }).toString();
        const url = `https://papi.binance.com/papi/v1/um/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
        const rp = await fetchJson(url, { headers });
        dbg.steps.push({ futuresFetch: { fapi: { status: r.status, textSample: r.text?.slice(0,120) }, papi: { status: rp.status, textSample: rp.text?.slice(0,120) } }});
        if (rp.ok) r = rp;
      } else {
        dbg.steps.push({ futuresFetch: { fapi: { status: r.status, textSample: r.text?.slice(0,120) } }});
      }

      if (r.ok && Array.isArray(r.json)) {
        const QUOTES = ["USDT"]; // USDT 마켓만
        const FUTURES_EXCLUDED_BASE = new Set(["BTC", "ETH"]); // 알트만

        const priceCache = new Map();
        async function getFuturesPrice(symbol) {
          if (priceCache.has(symbol)) return priceCache.get(symbol);
          const pr = await fetchJson(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { headers });
          const px = pr.ok ? Number(pr.json?.price) : 0;
          priceCache.set(symbol, px || 0);
          return px || 0;
        }

        for (const pos of r.json) {
          const amt = Number(pos?.positionAmt || 0);
          if (!amt) continue;

          const symbol = String(pos?.symbol || "");
          if (!QUOTES.some(q => symbol.endsWith(q))) continue; // USDT 마켓만
          const base = baseAssetFromSymbol(symbol);
          if (FUTURES_EXCLUDED_BASE.has(base)) continue;        // BTC/ETH 제외

          // 우선순위: notional(USDT) → markPrice → ticker 가격
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
          if (!usd) continue;

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

        altFuturesTop.sort((a, b) => b.usd - a.usd);
        altFuturesTop = altFuturesTop.slice(0, 25);
      }
    }

    // ===== 2) 지갑(Spot/Funding/Margin/Isolated/Earn) ALT USD 합계 =====
    const assetUSD = new Map(); // asset -> USD
    let usedPath = "getUserAsset";

    // 2-1) getUserAsset?needBtcValuation=true (코인별 합계)
    {
      const ts = Date.now();
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
        // 2-2) Fallback: Spot/Funding/Margin/Isolated
        usedPath = "fallback";

        // Spot: capital/config/getall
        {
          const ts = Date.now();
          const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url = `https://api.binance.com/sapi/v1/capital/config/getall?${qs}&signature=${sign(secretKey, qs)}`;
          const r2 = await fetchJson(url, { headers });
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

        // Funding: get-funding-asset (POST)
        {
          const ts = Date.now();
          const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url = `https://api.binance.com/sapi/v1/asset/get-funding-asset?${qs}&signature=${sign(secretKey, qs)}`;
          const r2 = await fetchJson(url, { method: "POST", headers });
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
          const ts = Date.now();
          const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
          const url = `https://api.binance.com/sapi/v1/margin/account?${qs}&signature=${sign(secretKey, qs)}`;
          const r2 = await fetchJson(url, { headers });
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
          const ts = Date.now();
          const qs = new URLSearchParams({ symbols: "all", timestamp: String(ts) }).toString();
          const url = `https://api.binance.com/sapi/v1/margin/isolated/account?${qs}&signature=${sign(secretKey, qs)}`;
          const r2 = await fetchJson(url, { headers });
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

    // 2-3) Simple Earn (유연/고정) 포함
    // 참고: 권한 없는 계정은 401/403 나올 수 있으므로 try/catch로 무시
    async function addSimpleEarnPositions() {
      // 유연
      try {
        const ts = Date.now();
        const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
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

      // 고정
      try {
        const ts = Date.now();
        const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
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

    // ----- 합계 및 상위 목록 -----
    let altWalletUSD = 0;
    let altWalletTop = [];
    for (const [asset, usd] of assetUSD.entries()) {
      altWalletUSD += usd;
      altWalletTop.push({ asset, usd: Number(usd.toFixed(2)) });
    }
    altWalletTop.sort((a, b) => b.usd - a.usd);
    altWalletTop = altWalletTop.slice(0, 25);

    const out = {
      altWalletUSD: Number(altWalletUSD.toFixed(2)),     // 지갑(Spot/Funding/Margin/Isolated + Simple Earn)
      altWalletTop,
      altFuturesUSD: Number(altFuturesUSD.toFixed(2)),   // USD-M 알트 포지션
      altFuturesTop,
      altTotalUSD: Number((altWalletUSD + altFuturesUSD).toFixed(2)), // 지갑 + 선물 합계
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      path: usedPath,
      t: Date.now()
    };
    if (debugMode) out._debug = dbg;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}