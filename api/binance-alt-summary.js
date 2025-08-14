// api/binance-alt-summary.js
import crypto from "crypto";

const EXCLUDED = new Set(["BTC", "ETH", "USDT", "USDC"]);
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
  return symbol.replace(/(USDT|USDC|BUSD)$/, "");
}
function pushUSD(map, asset, usd) {
  if (!asset || EXCLUDED.has(asset)) return;
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
    const ts = Date.now();
    const dbg = { steps: [] };

    // ----- 0) 가격 테이블 만들기 (USDT, USDC 마켓 둘 다) -----
    // 전체 ticker 한 방에: /api/v3/ticker/price  (배열)
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

    // ----- 1) 선물 USD-M 포지션 합계 (ALT만) -----
let altFuturesUSD = 0;
let altFuturesTop = [];
{
  const qs = new URLSearchParams({ timestamp: String(ts) }).toString();
  const url = `https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sign(secretKey, qs)}`;
  const r = await fetchJson(url, { headers });
  dbg.steps.push({ fapi_status: r.status, count: Array.isArray(r.json) ? r.json.length : 0 });

  if (r.ok && Array.isArray(r.json)) {
    // 사용자는 USDT 마켓만이라고 하셨으니 USDT만 필터(원하시면 USDC/FDUSD/BUSD 추가 가능)
    const QUOTES = ["USDT"]; // 필요 시 ["USDT","USDC","FDUSD","BUSD"]

    for (const pos of r.json) {
      const amt = toNum(pos.positionAmt);
      if (!amt) continue;

      const symbol = String(pos.symbol || "");
      if (!QUOTES.some(q => symbol.endsWith(q))) continue;

      // 기초자산 추출 (예: ARBUSDT -> ARB)
      const base = baseAssetFromSymbol(symbol);
      if (EXCLUDED.has(base)) continue; // BTC/ETH/USDT/USDC 제외(알트만)

      // ✅ notional(USDT 단위)이 제일 신뢰도 높음 → 1순위!
      const notional = toNum(pos.notional);
      const mark = toNum(pos.markPrice);

      // notional이 있으면 그걸 쓰고, 없으면 mark*qty로 폴백
      const usd = Math.abs(notional || (amt * mark));
      if (!usd) continue;

      if (usd >= MIN_USD) {
        altFuturesUSD += usd;
        altFuturesTop.push({
          symbol, base,
          positionSide: pos.positionSide || "BOTH",
          positionAmt: Number(amt.toFixed(6)),
          markPrice: mark ? Number(mark.toFixed(6)) : null,
          notional: notional ? Number(notional.toFixed(2)) : null,
          usd: Number(usd.toFixed(2)),
        });
      }
    }

    altFuturesTop.sort((a, b) => b.usd - a.usd);
    altFuturesTop = altFuturesTop.slice(0, 25);
  }
}

    // ----- 2) 지갑(Spot/Funding/Margin 등) ALT USD 합계 -----
    // 2-1) 1순위: getUserAsset?needBtcValuation=true
    const assetUSD = new Map(); // asset -> USD
    let usedPath = "getUserAsset";
    {
      const qs = new URLSearchParams({ timestamp: String(ts), needBtcValuation: "true" }).toString();
      const url = `https://api.binance.com/sapi/v3/asset/getUserAsset?${qs}&signature=${sign(secretKey, qs)}`;
      const r = await fetchJson(url, { headers });
      dbg.steps.push({ getUserAsset_status: r.status });

      if (r.ok && Array.isArray(r.json)) {
        // 이 응답은 코인별로 합쳐져 있고 btcValuation 포함
        // USD 환산은 (btcValuation * BTCUSDT)도 가능하지만,
        // 특정 알트가 USDT 마켓이 있다면 그 가격으로 재환산하는 편이 더 직접적임.
        for (const it of r.json) {
          const asset = it?.asset;
          if (!asset || EXCLUDED.has(asset)) continue;
          const total = toNum(it?.free) + toNum(it?.locked);
          if (!total) continue;

          // USDT 우선, 없으면 USDC
          let px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
          if (!px) continue; // 가격 없으면 스킵

          const usd = total * px;
          if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
        }
      } else {
        // 2-2) Fallback 체인
        usedPath = "fallback";

        // Spot: capital/config/getall
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

        // Funding: get-funding-asset (POST, form-encoded)
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

        // Cross Margin: /sapi/v1/margin/account
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
              if (total <= 0) continue; // 순수 잔고/순자산 기준
              const px = priceUSDT.get(asset) || priceUSDC.get(asset) || 0;
              if (!px) continue;
              const usd = total * px;
              if (usd >= MIN_USD) pushUSD(assetUSD, asset, usd);
            }
          }
        }

        // Isolated Margin: /sapi/v1/margin/isolated/account?symbols=all
        {
          const qs2 = new URLSearchParams({ symbols: "all", timestamp: String(ts) }).toString();
          const url2 = `https://api.binance.com/sapi/v1/margin/isolated/account?${qs2}&signature=${sign(secretKey, qs2)}`;
          const r2 = await fetchJson(url2, { headers });
          dbg.steps.push({ marginIso_status: r2.status, ok: r2.ok });

          if (r2.ok && r2.json?.assets && Array.isArray(r2.json.assets)) {
            for (const pair of r2.json.assets) {
              // pair.baseAsset / quoteAsset 구조
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

    // 합계 및 상위 목록
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
      altFuturesUSD: Number(altFuturesUSD.toFixed(2)),
      altFuturesTop,
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