/**
 * api/position-summary.js
 *
 * 통합 엔드포인트:
 *   GET /api/position-summary?exchange=bybit|bitget|okx|all   (기본: all)
 *
 * 반환(거래소별 공통 구조):
 * {
 *   exchange: "bybit|bitget|okx|aggregate",
 *   futures: {
 *     btcNetQty: number,         // BTC 순 수량(코인 단위; OKX는 ctVal 반영)
 *     ethNetQty: number,         // ETH 순 수량
 *     altFuturesUSD: number,     // ALT 선물 USD 순 노출 합계(롱 +, 숏 -)
 *     altFuturesTop: [           // ALT 상위 25개 (USD 기준)
 *       { symbol/instId, side, size/contracts, markPrice/markPx, usd, direction }
 *     ]
 *   },
 *   wallet: {
 *     altWalletUSD: number,      // 지갑(현물 등) ALT USD 합계
 *     altWalletTop: [ { asset, usd } ] // 상위 25개
 *   },
 *   t: timestamp(ms)
 * }
 *
 * 집계(aggregate)는 futures.altFuturesUSD / wallet.altWalletUSD 등을 합산해 제공합니다.
 */

import crypto from "crypto";

/* ============================================================================
 * 0) 공통 상수 / 유틸
 * ==========================================================================*/

// 지갑 합산에서 제외할 기초 자산(현금성/대형)
const EXCLUDE_ASSETS = new Set(["BTC", "ETH", "USDT", "USDC"]);

// 숫자 변환 유틸(안전한 Number 캐스팅)
const num = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

// JSON fetch 유틸(타임아웃/에러 텍스트 포함)
async function fetchJSON(url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(to);
  }
}

/* ============================================================================
 * 1) BYBIT
 *    - 선물 포지션: /v5/position/list?category=linear&settleCoin=USDT
 *    - 지갑(현물 등): /v5/account/wallet-balance?accountType=UNIFIED
 * ==========================================================================*/

// Bybit 서명
function bybitSign({ timestamp, apiKey, recvWindow, queryString, secretKey }) {
  const toSign = timestamp + apiKey + recvWindow + (queryString || "");
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

// Bybit 선물 포지션 요약(BTC/ETH 순 수량, ALT USD 합계/Top)
async function bybitFutures() {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error("BYBIT_KEYS");

  const BASE = "https://api.bybit.com";
  const recvWindow = "5000";
  const timestamp = Date.now().toString();

  const query = new URLSearchParams({
    category: "linear",
    settleCoin: "USDT",
  }).toString();

  const sig = bybitSign({ timestamp, apiKey, recvWindow, queryString: query, secretKey });

  const r = await fetchJSON(`${BASE}/v5/position/list?${query}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sig,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  if (!r.ok || r.json?.retCode !== 0) {
    throw new Error(`BYBIT_POS ${r.status} ${r.text?.slice(0, 120)}`);
  }

  const list = r.json?.result?.list || [];

  let btcNet = 0;
  let ethNet = 0;
  let altFuturesUSD = 0;
  const altTop = [];

  for (const p of list) {
    const symbol = String(p.symbol || "");
    const size = num(p.size);
    if (!symbol || !size) continue;

    const side = String(p.side || "").toUpperCase(); // BUY / SELL
    const signedQty = side === "BUY" ? size : side === "SELL" ? -size : 0;

    // 선물 USD 노출: positionValue 우선, 없으면 mark * qty
    let usd = 0;
    const pv = num(p.positionValue);
    if (pv) {
      usd = side === "BUY" ? pv : -pv;
    } else {
      const mark = num(p.markPrice);
      if (mark) usd = signedQty * mark;
    }

    if (symbol.startsWith("BTC")) {
      btcNet += signedQty;
    } else if (symbol.startsWith("ETH")) {
      ethNet += signedQty;
    } else if (Math.abs(usd) >= 100) {
      altFuturesUSD += usd;
      altTop.push({
        symbol,
        side,
        size: +size.toFixed(6),
        markPrice: p.markPrice ? +num(p.markPrice).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }

  altTop.sort((a, b) => b.usd - a.usd);

  return {
    btcNetQty: +btcNet.toFixed(8),
    ethNetQty: +ethNet.toFixed(8),
    altFuturesUSD: +altFuturesUSD.toFixed(2),
    altFuturesTop: altTop.slice(0, 25),
  };
}

// Bybit 지갑(현물 등) ALT USD 요약
async function bybitWallet() {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error("BYBIT_KEYS");

  const BASE = "https://api.bybit.com";
  const recvWindow = "5000";
  const timestamp = Date.now().toString();
  const query = "accountType=UNIFIED";

  const sig = bybitSign({ timestamp, apiKey, recvWindow, queryString: query, secretKey });

  const r = await fetchJSON(`${BASE}/v5/account/wallet-balance?${query}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sig,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  if (!r.ok || r.json?.retCode !== 0) {
    throw new Error(`BYBIT_BAL ${r.status} ${r.text?.slice(0, 120)}`);
  }

  const account = r.json?.result?.list?.[0];
  let altWalletUSD = 0;
  const altWalletTop = [];

  for (const c of account?.coin || []) {
    const asset = c?.coin;
    if (!asset || EXCLUDE_ASSETS.has(asset)) continue;

    const usd = num(c?.usdValue);
    if (usd >= 100) {
      altWalletUSD += usd;
      altWalletTop.push({ asset, usd: +usd.toFixed(2) });
    }
  }

  altWalletTop.sort((a, b) => b.usd - a.usd);

  return {
    altWalletUSD: +altWalletUSD.toFixed(2),
    altWalletTop: altWalletTop.slice(0, 25),
  };
}

/* ============================================================================
 * 2) BITGET
 *    - 선물 포지션: /api/v2/mix/position/all-position?productType=UMCBL&marginCoin=USDT
 *    - 지갑(현물): /api/v2/spot/account/assets (+ /api/v2/spot/market/tickers 로 가격)
 * ==========================================================================*/

// Bitget 서명
function bitgetSign(ts, method, path, query, body, secret) {
  const qs = query ? `?${query}` : "";
  const prehash = `${ts}${method.toUpperCase()}${path}${qs}${body || ""}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

// Bitget 선물 포지션 요약
async function bitgetFutures() {
  const apiKey = process.env.BITGET_API_KEY;
  const apiSecret = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) throw new Error("BITGET_KEYS");

  const ts = Date.now().toString();
  const method = "GET";
  const path = "/api/v2/mix/position/all-position";

  // 중요: productType=UMCBL + marginCoin=USDT 를 반드시 둘 다 사용
  const query = new URLSearchParams({ productType: "UMCBL", marginCoin: "USDT" }).toString();

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
    throw new Error(`BITGET_POS ${r.status} ${r.text?.slice(0, 140)}`);
  }

  const arr = Array.isArray(r.json?.data) ? r.json.data : [];

  let btcNet = 0;
  let ethNet = 0;
  let altFuturesUSD = 0;
  const altTop = [];

  for (const p of arr) {
    const instId = String(p.symbol || p.instId || "");
    const side = String(p.holdSide || p.posSide || "").toUpperCase(); // LONG / SHORT
    const total = num(p.total || p.totalPos || p.totalSize || p.size);
    if (!instId || !total) continue;

    const signedQty = side === "LONG" ? total : side === "SHORT" ? -total : 0;

    // USD 노출: usdt -> positionValue/margin -> markPrice
    let usd = 0;
    if (p.usdt) {
      usd = num(p.usdt);
      usd = side === "LONG" ? usd : -usd;
    } else if (p.positionValue || p.margin) {
      const v = num(p.positionValue || p.margin);
      usd = side === "LONG" ? v : -v;
    } else {
      const mark = num(p.markPrice || p.lastPr);
      usd = signedQty * mark;
    }

    if (instId.startsWith("BTC") || instId.includes("BTCUSDT")) {
      btcNet += signedQty;
    } else if (instId.startsWith("ETH") || instId.includes("ETHUSDT")) {
      ethNet += signedQty;
    } else if (Math.abs(usd) >= 100) {
      altFuturesUSD += usd;
      altTop.push({
        symbol: instId,
        side,
        size: +total.toFixed(6),
        markPrice: p.markPrice ? +num(p.markPrice).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }

  altTop.sort((a, b) => b.usd - a.usd);

  return {
    btcNetQty: +btcNet.toFixed(8),
    ethNetQty: +ethNet.toFixed(8),
    altFuturesUSD: +altFuturesUSD.toFixed(2),
    altFuturesTop: altTop.slice(0, 25),
  };
}

// Bitget 지갑(현물) ALT USD 요약
async function bitgetWallet() {
  const apiKey = process.env.BITGET_API_KEY;
  const apiSecret = process.env.BITGET_SECRET_KEY;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) throw new Error("BITGET_KEYS");

  const ts = Date.now().toString();
  const method = "GET";

  // 1) 보유 자산 조회
  const pathAssets = "/api/v2/spot/account/assets";
  const sigA = bitgetSign(ts, method, pathAssets, "", "", apiSecret);
  const rA = await fetchJSON(`https://api.bitget.com${pathAssets}`, {
    method,
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sigA,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
      "locale": "en-US",
    },
  });

  let assets = [];
  if (rA.ok && rA.json?.code === "00000" && Array.isArray(rA.json?.data)) {
    assets = rA.json.data;
  }

  // 2) 가격 조회(USDT 페어 티커)
  const tickersPath = "/api/v2/spot/market/tickers";
  const rT = await fetchJSON(`https://api.bitget.com${tickersPath}`);
  const priceMap = new Map(); // "COIN" -> last price in USDT

  if (rT.ok && rT.json?.data) {
    for (const t of rT.json.data) {
      const sym = String(t.symbol || ""); // 예: "SOLUSDT"
      if (sym.endsWith("USDT")) {
        const coin = sym.slice(0, -4); // 마지막 "USDT" 제거
        priceMap.set(coin, num(t.close));
      }
    }
  }

  let altWalletUSD = 0;
  const altWalletTop = [];

  for (const a of assets) {
    const coin = String(a.coin || a.asset || a.symbol || "");
    if (!coin || EXCLUDE_ASSETS.has(coin)) continue;

    const free = num(a.available || a.availableBalance || a.frozen || a.holdBalance || a.balance || a.total);
    if (!free) continue;

    const px = priceMap.get(coin) || 0;
    if (!px) continue;

    const usd = free * px;
    if (usd >= 100) {
      altWalletUSD += usd;
      altWalletTop.push({ asset: coin, usd: +usd.toFixed(2) });
    }
  }

  altWalletTop.sort((a, b) => b.usd - a.usd);

  return {
    altWalletUSD: +altWalletUSD.toFixed(2),
    altWalletTop: altWalletTop.slice(0, 25),
  };
}

/* ============================================================================
 * 3) OKX
 *    - 선물 포지션: /api/v5/account/positions?instType=SWAP (+ /public/instruments ctVal)
 *    - 지갑(현물 등): /api/v5/account/balance (eqUsd 사용)
 * ==========================================================================*/

const OKX_BASE = "https://www.okx.com";

// OKX 서명
function okxSign({ ts, method, requestPath, body = "", secret }) {
  const prehash = `${ts}${method}${requestPath}${body}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

// OKX 공통 호출 래퍼
async function okxFetch({ endpoint, method = "GET", query = "", bodyObj = null, key, secret, passphrase }) {
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const path = query ? `${endpoint}?${query}` : endpoint;
  const sign = okxSign({ ts, method, requestPath: path, body, secret });
  const url = `${OKX_BASE}${path}`;

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
    throw new Error(`OKX_API ${r.status} ${j?.msg || ""}`);
  }
  return j;
}

// OKX 선물 포지션 요약(ctVal 기반 코인 수량 복원)
async function okxFutures() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error("OKX_KEYS");

  // 포지션
  const pos = await okxFetch({
    endpoint: "/api/v5/account/positions",
    query: "instType=SWAP",
    key, secret, passphrase,
  });
  const list = Array.isArray(pos?.data) ? pos.data : [];

  // 인스트루먼트 메타(계약당 코인 수 ctVal)
  const inst = await okxFetch({
    endpoint: "/api/v5/public/instruments",
    query: "instType=SWAP",
    key, secret, passphrase,
  });
  const instMap = new Map();
  for (const it of inst?.data || []) {
    instMap.set(String(it.instId), { ctVal: num(it.ctVal) });
  }

  let btcNet = 0;
  let ethNet = 0;
  let altFuturesUSD = 0;
  const altTop = [];

  for (const p of list) {
    const instId = String(p.instId || "");
    if (!instId.endsWith("-SWAP")) continue;

    const side = String(p.posSide || "").toUpperCase(); // LONG / SHORT
    const sz = num(p.pos || p.sz); // 계약 수(컨트랙트)
    if (!instId || !sz) continue;

    const meta = instMap.get(instId) || {};
    const ctVal = num(meta.ctVal, 0); // 1 계약 당 기초 코인 수
    const coinQty = ctVal ? sz * (side === "SHORT" ? -1 : 1) * ctVal : 0;

    // USD 노출: notionalUsd 우선, 없으면 markPx*coinQty
    let usd = 0;
    if (p.notionalUsd !== undefined) {
      usd = num(p.notionalUsd);
      usd = side === "SHORT" ? -usd : usd;
    } else {
      const mark = num(p.markPx);
      usd = coinQty * mark;
    }

    if (instId.startsWith("BTC-")) {
      btcNet += coinQty;
    } else if (instId.startsWith("ETH-")) {
      ethNet += coinQty;
    } else if (Math.abs(usd) >= 100) {
      altFuturesUSD += usd;
      altTop.push({
        instId,
        side,
        contracts: +sz.toFixed(4),
        ctVal,
        coinQty: +coinQty.toFixed(8),
        markPx: p.markPx ? +num(p.markPx).toFixed(6) : null,
        usd: +usd.toFixed(2),
        direction: usd > 0 ? "LONG" : "SHORT",
      });
    }
  }

  altTop.sort((a, b) => b.usd - a.usd);

  return {
    btcNetQty: +btcNet.toFixed(8),
    ethNetQty: +ethNet.toFixed(8),
    altFuturesUSD: +altFuturesUSD.toFixed(2),
    altFuturesTop: altTop.slice(0, 25),
  };
}

// OKX Savings(Earn) 잔액을 USD로 환산하여 합계/상위 목록 반환
// - 잔액: /api/v5/finance/savings/balance
// - 가격: /api/v5/market/tickers?instType=SPOT (COIN-USDT 매칭)
async function okxSavingsBalancesUSD() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error("OKX_KEYS");

  // 1) Savings 잔액
  const savings = await okxFetch({
    endpoint: "/api/v5/finance/savings/balance",
    key, secret, passphrase,
  });
  const items = Array.isArray(savings?.data) ? savings.data : [];

  // 2) USDT 페어 스팟 가격
  const tick = await fetchJSON(`${OKX_BASE}/api/v5/market/tickers?instType=SPOT`);
  const price = new Map(); // "COIN" -> last price in USDT
  if (tick.ok && Array.isArray(tick.json?.data)) {
    for (const t of tick.json.data) {
      const inst = String(t.instId || ""); // 예: "OKB-USDT"
      const m = inst.match(/^([A-Z0-9]+)-USDT$/);
      if (m) price.set(m[1], num(t.last));
    }
  }

  let total = 0;
  const top = [];

  for (const it of items) {
    const ccy = String(it.ccy || it.asset || it.currency || "");
    if (!ccy || EXCLUDE_ASSETS.has(ccy)) continue;

    // amt/amount/balance 필드 케이스 가드
    const amt = num(it.amt || it.amount || it.balance || it.bal || it.availBal || it.available || it.total);
    if (!amt) continue;

    const px = price.get(ccy) || 0;
    if (!px) continue;

    const usd = amt * px;
    if (usd >= 100) {
      total += usd;
      top.push({ asset: ccy, usd: +usd.toFixed(2) });
    }
  }

  top.sort((a, b) => b.usd - a.usd);
  return {
    altSavingsUSD: +total.toFixed(2),
    altSavingsTop: top.slice(0, 25),
  };
}

// OKX 지갑(현물 eqUsd) + Savings(Earn) USD 합산
async function okxWallet() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error("OKX_KEYS");

  // 1) 현물/마진 등 계정 잔액: eqUsd 사용
  const bal = await okxFetch({
    endpoint: "/api/v5/account/balance",
    key, secret, passphrase,
  });
  const details = bal?.data?.[0]?.details || [];

  let spotUSD = 0;
  const spotTop = [];
  for (const d of details) {
    const asset = d.ccy || "";
    if (!asset || EXCLUDE_ASSETS.has(asset)) continue;

    const usd = num(d.eqUsd);
    if (usd >= 100) {
      spotUSD += usd;
      spotTop.push({ asset, usd: +usd.toFixed(2) });
    }
  }
  spotTop.sort((a, b) => b.usd - a.usd);

  // 2) Savings(Earn) 잔액 환산
  const savings = await okxSavingsBalancesUSD().catch(() => ({
    altSavingsUSD: 0,
    altSavingsTop: [],
  }));

  // 3) 합산 및 상위 25개
  const totalUSD = spotUSD + num(savings.altSavingsUSD);
  const combinedTop = [...spotTop, ...(savings.altSavingsTop || [])]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 25);

  return {
    altWalletUSD: +totalUSD.toFixed(2),
    altWalletTop: combinedTop,
    components: {
      spotUSD: +spotUSD.toFixed(2),
      savingsUSD: +num(savings.altSavingsUSD).toFixed(2),
    },
  };
}

/* ============================================================================
 * 4) 핸들러(라우팅/집계)
 * ==========================================================================*/

export default async function handler(req, res) {
  try {
    const ex = String(req.query?.exchange || "all").toLowerCase();

    // 개별 거래소: futures + wallet 동시 호출
    if (ex === "bybit") {
      const [futures, wallet] = await Promise.all([bybitFutures(), bybitWallet()]);
      return res.status(200).json({ exchange: "bybit", futures, wallet, t: Date.now() });
    }
    if (ex === "bitget") {
      const [futures, wallet] = await Promise.all([bitgetFutures(), bitgetWallet()]);
      return res.status(200).json({ exchange: "bitget", futures, wallet, t: Date.now() });
    }
    if (ex === "okx") {
      const [futures, wallet] = await Promise.all([okxFutures(), okxWallet()]);
      return res.status(200).json({ exchange: "okx", futures, wallet, t: Date.now() });
    }

    // 전체(ALL): 6개 호출 병렬 수행
    const all = await Promise.allSettled([
      bybitFutures(), bybitWallet(),
      bitgetFutures(), bitgetWallet(),
      okxFutures(),   okxWallet(),
    ]);

    // 결과 수집(성공/실패 구분)
    const pick = (ps, i) =>
      ps[i].status === "fulfilled"
        ? ps[i].value
        : { error: String(ps[i].reason?.message || ps[i].reason || "err") };

    const out = {
      bybit: { exchange: "bybit", futures: pick(all, 0), wallet: pick(all, 1) },
      bitget:{ exchange: "bitget", futures: pick(all, 2), wallet: pick(all, 3) },
      okx:   { exchange: "okx", futures: pick(all, 4), wallet: pick(all, 5) },
    };

    // 집계(aggregate): BTC/ETH 순 수량 + ALT 선물/지갑 USD 합계
    const agg = { btcNetQty: 0, ethNetQty: 0, altFuturesUSD: 0, altWalletUSD: 0 };
    for (const exName of ["bybit", "bitget", "okx"]) {
      const v = out[exName];
      if (v?.futures?.btcNetQty != null)   agg.btcNetQty += num(v.futures.btcNetQty);
      if (v?.futures?.ethNetQty != null)   agg.ethNetQty += num(v.futures.ethNetQty);
      if (v?.futures?.altFuturesUSD != null) agg.altFuturesUSD += num(v.futures.altFuturesUSD);
      if (v?.wallet?.altWalletUSD != null) agg.altWalletUSD += num(v.wallet.altWalletUSD);
    }

    out.aggregate = {
      exchange: "aggregate",
      futures: {
        btcNetQty: +agg.btcNetQty.toFixed(8),
        ethNetQty: +agg.ethNetQty.toFixed(8),
        altFuturesUSD: +agg.altFuturesUSD.toFixed(2),
      },
      wallet: {
        altWalletUSD: +agg.altWalletUSD.toFixed(2),
      },
      t: Date.now(),
    };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}