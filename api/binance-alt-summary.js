// api/binance-alt-summary.js
import crypto from "crypto";

// ----- 설정 -----
const EXCLUDED = new Set(["BTC", "ETH"]);   // 알트 = BTC/ETH 제외
const MIN_USD = 100;                         // $100 이상만 집계
const TIMEOUT_MS = 3000;

// 공용: 타임아웃 fetch(JSON 시도)
async function fetchJson(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

// 공용: 사인/서명 요청
function signQS(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}
async function signedFetch(base, path, apiKey, secretKey, params = {}, timeoutMs = TIMEOUT_MS) {
  const query = new URLSearchParams({ timestamp: Date.now(), ...params }).toString();
  const sig = signQS(secretKey, query);
  const url = `${base}${path}?${query}&signature=${sig}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey }, signal: controller.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

// BTCUSDT 가격 (지갑 BTC평가→USD 전환에 필요)
async function getBtcUsdt(debug) {
  // Binance → Bybit → Coinbase 순
  {
    const r = await fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    debug.prices.push({ source: "binance", ...r, text: undefined });
    const p = Number(r?.json?.price);
    if (r.ok && p > 0) return p;
  }
  {
    const r = await fetchJson("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT");
    debug.prices.push({ source: "bybit", ok: r.ok, status: r.status, sample: JSON.stringify(r.json)?.slice(0, 200) });
    const p = Number(r?.json?.result?.list?.[0]?.lastPrice);
    if (r.ok && p > 0) return p;
  }
  {
    const r = await fetchJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
    debug.prices.push({ source: "coinbase", ok: r.ok, status: r.status, sample: r.text?.slice(0, 200) });
    const p = Number(r?.json?.price ?? r?.json?.last);
    if (r.ok && p > 0) return p;
  }
  return 0;
}

// 지갑(현물/마진/펀딩 등) 알트 총액 USD 계산
async function getAltWalletUSD(apiKey, secretKey, debug) {
  const r = await signedFetch(
    "https://api.binance.com",
    "/sapi/v3/asset/getUserAsset",
    apiKey,
    secretKey,
    { needBtcValuation: true }
  );
  debug.wallet.push({ step: "getUserAsset", ok: r.ok, status: r.status, sample: r.text?.slice(0, 200) });

  if (!r.ok || !Array.isArray(r.json)) {
    return { totalUSD: 0, items: [], reason: "wallet_fetch_failed" };
  }

  const btcUsdt = await getBtcUsdt(debug);
  if (!btcUsdt) return { totalUSD: 0, items: [], reason: "no_btcusdt_price" };

  let totalUSD = 0;
  const items = [];

  for (const a of r.json) {
    const asset = (a.asset || "").toUpperCase();
    if (!asset || EXCLUDED.has(asset)) continue;

    // 총 수량
    const qty =
      (Number(a.free) || 0) +
      (Number(a.locked) || 0) +
      (Number(a.freeze) || 0) +
      (Number(a.withdrawing) || 0);

    // BTC 평가액 → USD
    const btcVal = Number(a.btcValuation) || 0;
    const usd = btcVal * btcUsdt;

    if (qty > 0 && usd >= MIN_USD) {
      items.push({ asset, qty: Number(qty.toFixed(8)), usd: Number(usd.toFixed(2)) });
      totalUSD += usd;
    }
  }

  items.sort((x, y) => y.usd - x.usd);
  return { totalUSD: Number(totalUSD.toFixed(2)), items };
}

// USD‑M 선물 알트 포지션 총액 USD 계산 (|수량| * markPrice)
async function getAltFuturesUSD(apiKey, secretKey, debug) {
  const r = await signedFetch(
    "https://fapi.binance.com",
    "/fapi/v2/positionRisk",
    apiKey,
    secretKey
  );
  debug.futures.push({ step: "positionRisk", ok: r.ok, status: r.status, sample: r.text?.slice(0, 200) });

  if (!r.ok || !Array.isArray(r.json)) {
    return { totalUSD: 0, items: [], reason: "futures_fetch_failed" };
  }

  const map = new Map();
  for (const p of r.json) {
    const amt = Number(p.positionAmt) || 0;
    if (amt === 0) continue;

    const symbol = String(p.symbol || "");
    let base = symbol.endsWith("USDT") ? symbol.slice(0, -5) : symbol; // e.g. ARBUSDT -> ARB
    base = base.toUpperCase();

    if (EXCLUDED.has(base)) continue;

    const usd = Math.abs(amt * (Number(p.markPrice) || 0));
    if (usd >= MIN_USD) {
      map.set(base, (map.get(base) || 0) + usd);
    }
  }

  const items = Array.from(map.entries())
    .map(([asset, usd]) => ({ asset, usd: Number(usd.toFixed(2)) }))
    .sort((a, b) => b.usd - a.usd);

  const totalUSD = items.reduce((s, it) => s + it.usd, 0);
  return { totalUSD: Number(totalUSD.toFixed(2)), items };
}

export default async function handler(req, res) {
  const debug = { prices: [], wallet: [], futures: [] };
  const wantDebug = (req?.query?.debug === "1") || (new URL(req.url, "http://x").searchParams.get("debug") === "1");

  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }

    const [wallet, futures] = await Promise.all([
      getAltWalletUSD(apiKey, secretKey, debug),
      getAltFuturesUSD(apiKey, secretKey, debug),
    ]);

    const payload = {
      altWalletUSD: wallet.totalUSD,
      altWalletTop: wallet.items?.slice(0, 20) || [],
      altFuturesUSD: futures.totalUSD,
      altFuturesTop: futures.items?.slice(0, 20) || [],
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      t: Date.now(),
    };
    if (wantDebug) payload.debug = debug;

    return res.status(200).json(payload);
  } catch (e) {
    // 절대 크래시하지 않도록
    const msg = e?.message || String(e);
    return res.status(500).json({ error: "UnhandledError", message: msg, t: Date.now(), debug: wantDebug ? debug : undefined });
  }
}