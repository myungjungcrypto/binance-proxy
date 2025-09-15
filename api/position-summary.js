// api/position-summary.js
// Unified futures position summary for Bybit, Bitget, OKX
// Usage: /api/position-summary?exchange=bybit|bitget|okx|all
// ENV:
// - BYBIT_API_KEY, BYBIT_SECRET_KEY
// - BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_API_PASSPHRASE
// - OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE

import crypto from "crypto";

/* ------------------------------ utils ------------------------------ */

async function fetchJSON(url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  } finally {
    clearTimeout(to);
  }
}
const n = (v, d=0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/* ------------------------------ BYBIT ------------------------------ */
/**
 * Bybit v5 Positions (linear)
 * - BTC/ETH: net size (base units)
 * - ALT: signed USD notional using positionValue (fallback markPrice*size)
 *
 * ENV: BYBIT_API_KEY, BYBIT_SECRET_KEY
 */
function bybitSign({ timestamp, apiKey, recvWindow, queryString, secretKey }) {
  const toSign = timestamp + apiKey + recvWindow + (queryString || "");
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

async function getBybitSummary() {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error("Missing Bybit API credentials");

  const BASE = "https://api.bybit.com";
  const recvWindow = "5000";
  const timestamp = Date.now().toString();
  const q = new URLSearchParams({ category: "linear", settleCoin: "USDT" }).toString();
  const sig = bybitSign({ timestamp, apiKey, recvWindow, queryString: q, secretKey });
  const url = `${BASE}/v5/position/list?${q}`;
  const r = await fetchJSON(url, {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sig,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  if (!r.ok || r.json?.retCode !== 0) {
    throw new Error(`Bybit API Error (positions): ${r.status} ${r.text?.slice(0,200)}`);
  }
  const list = r.json?.result?.list || [];

  let btcNet = 0, ethNet = 0, altUSD = 0;
  const top = [];

  for (const p of list) {
    const symbol = String(p.symbol || "");
    const size = n(p.size);
    if (!symbol || !size) continue;
    const side = String(p.side || "").toUpperCase(); // BUY/SELL
    const signedQty = side === "BUY" ? size : side === "SELL" ? -size : 0;

    let usd = 0;
    const pv = n(p.positionValue);
    if (pv) usd = side === "BUY" ? pv : -pv;
    else {
      const mark = n(p.markPrice);
      if (mark) usd = signedQty * mark;
    }

    if (symbol.startsWith("BTC")) btcNet += signedQty;
    else if (symbol.startsWith("ETH")) ethNet += signedQty;
    else if (Math.abs(usd) >= 100) {
      altUSD += usd;
      top.push({
        symbol,
        side,
        size: +size.toFixed(6),
        markPrice: p.markPrice ? +n(p.markPrice).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }
  top.sort((a,b) => b.usd - a.usd);

  return {
    exchange: "bybit",
    futures: {
      btcNetQty: +btcNet.toFixed(8),
      ethNetQty: +ethNet.toFixed(8),
      altFuturesUSD: +altUSD.toFixed(2),
      altFuturesTop: top.slice(0, 25),
    },
    t: Date.now(),
  };
}

/* ------------------------------ BITGET ------------------------------ */
/**
 * Bitget v2 UMCBL (USDT-M) positions
 * - BTC/ETH: net total
 * - ALT: signed USD (prefer usdt/positionValue; else mark*size)
 *
 * ENV: BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_API_PASSPHRASE
 */
function bitgetSign(ts, method, path, query, body, secret) {
  const qs = query ? `?${query}` : "";
  const prehash = `${ts}${method.toUpperCase()}${path}${qs}${body || ""}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function getBitgetSummary() {
  const apiKey = process.env.BITGET_API_KEY;
  const apiSecret = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) throw new Error("Missing Bitget API credentials");

  const ts = Date.now().toString();
  const method = "GET";
  const path = "/api/v2/mix/position/all-position";
  const query = "productType=umcblproductType=umcblmarginCoin=USDTproductType=umcblmarginCoin=USDT";
  const sig = bitgetSign(ts, method, path, query, "", apiSecret);

  const r = await fetchJSON(`https://api.bitget.com${path}?${query}`, {
    method,
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
      "locale": "en-US",
    },
  });
  if (!r.ok || r.json?.code !== "00000") {
    throw new Error(`Bitget API Error (positions): ${r.status} ${r.text?.slice(0,200)}`);
  }
  const positions = Array.isArray(r.json?.data) ? r.json.data : [];

  let btcNet = 0, ethNet = 0, altUSD = 0;
  const top = [];

  for (const p of positions) {
    const instId = String(p.symbol || p.instId || "");
    const holdSide = String(p.holdSide || p.posSide || "").toUpperCase(); // LONG/SHORT
    const total = n(p.total || p.totalPos || p.totalSize || p.size);
    if (!instId || !total) continue;

    const signedQty = holdSide === "LONG" ? total : holdSide === "SHORT" ? -total : 0;

    let usd = 0;
    if (p.usdt) {
      usd = n(p.usdt);
      usd = holdSide === "LONG" ? usd : -usd;
    } else if (p.positionValue || p.margin) {
      const v = n(p.positionValue || p.margin);
      usd = holdSide === "LONG" ? v : -v;
    } else {
      const mark = n(p.markPrice || p.lastPr);
      usd = signedQty * mark;
    }

    if (instId.startsWith("BTC") || instId.includes("BTCUSDT")) btcNet += signedQty;
    else if (instId.startsWith("ETH") || instId.includes("ETHUSDT")) ethNet += signedQty;
    else if (Math.abs(usd) >= 100) {
      altUSD += usd;
      top.push({
        symbol: instId,
        side: holdSide,
        size: +total.toFixed(6),
        markPrice: p.markPrice ? +n(p.markPrice).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }
  top.sort((a,b) => b.usd - a.usd);

  return {
    exchange: "bitget",
    futures: {
      btcNetQty: +btcNet.toFixed(8),
      ethNetQty: +ethNet.toFixed(8),
      altFuturesUSD: +altUSD.toFixed(2),
      altFuturesTop: top.slice(0, 25),
    },
    t: Date.now(),
  };
}

/* ------------------------------- OKX ------------------------------- */
/**
 * OKX SWAP positions + instruments (ctVal)
 * - Convert contracts (sz) to coinQty via ctVal, then:
 *   BTC/ETH: net coinQty; ALT: signed notionalUsd (fallback markPx*coinQty)
 *
 * ENV: OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE
 */
const OKX_BASE = "https://www.okx.com";
function okxSign({ ts, method, requestPath, body = "", secret }) {
  const prehash = `${ts}${method}${requestPath}${body}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}
async function okxFetch({ endpoint, method = "GET", query = "", bodyObj = null, key, secret, passphrase }) {
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const requestPath = query ? `${endpoint}?${query}` : endpoint;
  const sign = okxSign({ ts, method, requestPath, body, secret });
  const url = `${OKX_BASE}${requestPath}`;
  const r = await fetch(url, {
    method,
    headers: {
      "OK-ACCESS-KEY": key,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
    },
    body: body || undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok || j?.code !== "0") {
    const msg = j?.msg || j?.error_message || "?";
    throw new Error(`OKX API error ${endpoint} HTTP ${r.status} code=${j?.code} msg=${msg}`);
  }
  return j;
}

async function getOkxSummary() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error("Missing OKX API credentials");

  const pos = await okxFetch({
    endpoint: "/api/v5/account/positions",
    query: "instType=SWAP",
    key, secret, passphrase,
  });
  const list = Array.isArray(pos?.data) ? pos.data : [];

  const inst = await okxFetch({
    endpoint: "/api/v5/public/instruments",
    query: "instType=SWAP",
    key, secret, passphrase,
  });
  const instMap = new Map();
  for (const it of inst?.data || []) {
    instMap.set(String(it.instId), { ctVal: n(it.ctVal), ctValCcy: it.ctValCcy });
  }

  let btcNet = 0, ethNet = 0, altUSD = 0;
  const top = [];

  for (const p of list) {
    const instId = String(p.instId || "");
    if (!instId.endsWith("-SWAP")) continue;
    const side = String(p.posSide || "").toUpperCase(); // LONG/SHORT
    const sz = n(p.pos || p.sz);
    if (!instId || !sz) continue;

    const meta = instMap.get(instId) || {};
    const ctVal = n(meta.ctVal, 0);
    const coinQty = ctVal ? sz * (side === "SHORT" ? -1 : 1) * ctVal : 0;

    let usd = 0;
    if (p.notionalUsd !== undefined) {
      usd = n(p.notionalUsd);
      usd = side === "SHORT" ? -usd : usd;
    } else {
      const markPx = n(p.markPx);
      usd = coinQty * markPx;
    }

    if (instId.startsWith("BTC-")) btcNet += coinQty;
    else if (instId.startsWith("ETH-")) ethNet += coinQty;
    else if (Math.abs(usd) >= 100) {
      altUSD += usd;
      top.push({
        instId,
        side,
        contracts: +sz.toFixed(4),
        ctVal,
        coinQty: +coinQty.toFixed(8),
        markPx: p.markPx ? +n(p.markPx).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }
  top.sort((a,b) => b.usd - a.usd);

  return {
    exchange: "okx",
    futures: {
      btcNetQty: +btcNet.toFixed(8),
      ethNetQty: +ethNet.toFixed(8),
      altFuturesUSD: +altUSD.toFixed(2),
      altFuturesTop: top.slice(0, 25),
    },
    t: Date.now(),
  };
}

/* ---------------------------- unified API --------------------------- */

export default async function handler(req, res) {
  try {
    const ex = String(req.query?.exchange || "all").toLowerCase();

    if (ex === "bybit") {
      const out = await getBybitSummary();
      return res.status(200).json(out);
    }
    if (ex === "bitget") {
      const out = await getBitgetSummary();
      return res.status(200).json(out);
    }
    if (ex === "okx") {
      const out = await getOkxSummary();
      return res.status(200).json(out);
    }

    // all: run in parallel
    const [bybit, bitget, okx] = await Promise.allSettled([
      getBybitSummary(), getBitgetSummary(), getOkxSummary()
    ]);

    const results = {};
    if (bybit.status === "fulfilled") results.bybit = bybit.value;
    else results.bybit = { error: bybit.reason?.message || String(bybit.reason) };

    if (bitget.status === "fulfilled") results.bitget = bitget.value;
    else results.bitget = { error: bitget.reason?.message || String(bitget.reason) };

    if (okx.status === "fulfilled") results.okx = okx.value;
    else results.okx = { error: okx.reason?.message || String(okx.reason) };

    // Optional: aggregate a grand view (sum BTC/ETH/ALT)
    const agg = { btcNetQty: 0, ethNetQty: 0, altFuturesUSD: 0 };
    for (const k of ["bybit","bitget","okx"]) {
      const v = results[k];
      if (!v || !v.futures) continue;
      agg.btcNetQty += n(v.futures.btcNetQty);
      agg.ethNetQty += n(v.futures.ethNetQty);
      agg.altFuturesUSD += n(v.futures.altFuturesUSD);
    }
    results.aggregate = {
      exchange: "aggregate",
      futures: {
        btcNetQty: +agg.btcNetQty.toFixed(8),
        ethNetQty: +agg.ethNetQty.toFixed(8),
        altFuturesUSD: +agg.altFuturesUSD.toFixed(2),
      },
      t: Date.now(),
    };

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}