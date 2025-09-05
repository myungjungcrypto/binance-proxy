// api/okx-balance.js
import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";
const API_KEY = process.env.OKX_API_KEY;
const API_SECRET = process.env.OKX_API_SECRET;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE;

function okxTimestamp() {
  return new Date().toISOString();
}

/**
 * OKX v5 서명
 * sign = Base64(HMAC_SHA256(timestamp + method + requestPath + body, secret))
 * GET에서 body는 빈 문자열, requestPath에는 반드시 쿼리스트링 포함
 */
function okxSign({ ts, method, requestPath, body = "" }) {
  const prehash = `${ts}${method}${requestPath}${body}`;
  return crypto.createHmac("sha256", API_SECRET).update(prehash).digest("base64");
}

async function okxFetch({ method = "GET", endpoint, query = "", bodyObj = null }) {
  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    const err = new Error("Missing OKX API credentials");
    err._client = true;
    throw err;
  }

  const ts = okxTimestamp();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const requestPath = query ? `${endpoint}?${query}` : endpoint;
  const sign = okxSign({ ts, method, requestPath, body });

  const url = `${OKX_BASE}${requestPath}`;
  const r = await fetch(url, {
    method,
    headers: {
      "OK-ACCESS-KEY": API_KEY,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": API_PASSPHRASE,
      "OK-ACCESS-PROJECT": "binance-proxy/okx-balance",
      "Content-Type": "application/json",
    },
    body: body || undefined,
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`OKX ${endpoint} parse error: HTTP ${r.status} ${text}`);
    err._raw = text;
    throw err;
  }

  // OKX v5: { code: "0", data: [...] }
  if (!r.ok || json?.code !== "0") {
    const err = new Error(
      `OKX ${endpoint} error: HTTP ${r.status} / code=${json?.code} msg=${json?.msg || json?.error_message || "?"}`
    );
    err._json = json;
    err._status = r.status;
    throw err;
  }
  return json;
}

// 안전 파서
const f = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export default async function handler(req, res) {
  try {
    const debug = req.query && (req.query.debug === "1" || req.query.debug === "true");

    // 1) 모드 표기: Advanced / Multi-Currency(고정 표기)
    const mode = "Advanced / Multi-Currency";

    // 2) 거래계정(UNIFIED) USD 총액: /api/v5/account/balance → details[].eqUsd 합
    let tradingUSD = 0;
    let topCoins = []; // { ccy, usd } 후보

    let rawAccount = null;
    try {
      rawAccount = await okxFetch({
        method: "GET",
        endpoint: "/api/v5/account/balance",
      });
      const details = rawAccount?.data?.[0]?.details || [];
      for (const d of details) {
        const usd = f(d.eqUsd);
        tradingUSD += usd;
        // 코인별 USD 파악(상위표 용)
        const ccy = d.ccy || d.currency || "?";
        topCoins.push({ ccy, usd });
      }
    } catch (e) {
      // 거래계정 실패해도 계속 진행
      rawAccount = { error: e.message, data: e._json ?? e._raw ?? null };
    }

    // 3) 펀딩 지갑: /api/v5/asset/balances → USDT만 1:1 USD로 합산
    //    (다른 코인은 가격 오라클 연결 전까지 합산 제외)
    let fundingUSD = 0;
    let rawFunding = null;
    try {
      rawFunding = await okxFetch({
        method: "GET",
        endpoint: "/api/v5/asset/balances",
      });
      const balances = rawFunding?.data || [];
      for (const b of balances) {
        const ccy = b.ccy || b.currency || "";
        const amt = f(b.bal); // 현 잔액
        if (ccy === "USDT") {
          fundingUSD += amt; // 1:1
          topCoins.push({ ccy: "USDT(Funding)", usd: amt });
        }
      }
    } catch (e) {
      rawFunding = { error: e.message, data: e._json ?? e._raw ?? null };
    }

    // 4) Earn(Savings) 잔액: /api/v5/finance/savings/balance → USDT만 1:1 USD
    let earnSavingsUSD = 0;
    let rawSavings = null;
    try {
      rawSavings = await okxFetch({
        method: "GET",
        endpoint: "/api/v5/finance/savings/balance",
      });
      const list = rawSavings?.data || [];
      for (const it of list) {
        const ccy = it.ccy || it.currency || "";
        // OKX 응답 예: { ccy: "USDT", amt: "17800", ... }
        const amt = f(it.amt ?? it.balance ?? 0);
        if (ccy === "USDT") {
          earnSavingsUSD += amt;
          topCoins.push({ ccy: "USDT(Savings)", usd: amt });
        }
      }
    } catch (e) {
      // 엔드포인트 지역/계정별 미지원일 수 있음 — 무시하고 진행
      rawSavings = { warn: e.message, data: e._json ?? e._raw ?? null };
    }

    // 5) Earn(DeFi Staking) 포지션(선택): /api/v5/finance/staking-defi/positions
    //    일부 계정/지역에서 404 나올 수 있으므로 “베스트 에포트”로 처리
    let earnDefiUSD = 0;
    let rawDefi = null;
    try {
      rawDefi = await okxFetch({
        method: "GET",
        endpoint: "/api/v5/finance/staking-defi/positions",
      });
      const positions = rawDefi?.data || [];
      for (const p of positions) {
        const ccy = p.ccy || p.productCcy || "";
        // 가정: USDT 스테이킹/디파이 포지션만 1:1 USD로 반영
        // 가능한 필드: amt, principal, investAmt 등 — 수치 존재 우선순위로 집계
        const amt = f(p.amt ?? p.principal ?? p.investAmt ?? 0);
        if (ccy === "USDT") {
          earnDefiUSD += amt;
          topCoins.push({ ccy: "USDT(DeFi)", usd: amt });
        }
      }
    } catch (e) {
      rawDefi = { warn: e.message, data: e._json ?? e._raw ?? null };
    }

    // 6) 부분합(수동 합산)
    const subtotalUSD = tradingUSD + fundingUSD + earnSavingsUSD + earnDefiUSD;

    // 7) 공식 총 평가액: /api/v5/asset/asset-valuation?ccy=USD
    let valuationUSD = 0;
    let rawValuation = null;
    try {
      rawValuation = await okxFetch({
        method: "GET",
        endpoint: "/api/v5/asset/asset-valuation",
        query: "ccy=USD",
      });
      // 응답 예: { data: [{ details: [...], totalBal:"132502.06", ts: "..." }] }
      const row = rawValuation?.data?.[0];
      valuationUSD = f(row?.totalBal ?? row?.totalBalInUsd ?? row?.totalUsd);
    } catch (e) {
      rawValuation = { warn: e.message, data: e._json ?? e._raw ?? null };
    }

    // 8) 상위 코인 USD (거래 eqUsd + Funding/Earn의 USDT만)
    const topCoinsUSD = topCoins
      .filter((x) => x.usd && Number.isFinite(x.usd))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);

    // 9) 최종 totalUSD: valuation(있으면) 우선, 없으면 subtotal 사용
    const totalUSD = valuationUSD > 0 ? valuationUSD : subtotalUSD;

    const payload = {
      mode,
      totals: {
        tradingUSD: Math.round(tradingUSD * 100) / 100,
        fundingUSD: Math.round(fundingUSD * 100) / 100,
        earnSavingsUSD: Math.round(earnSavingsUSD * 100) / 100,
        earnDefiUSD: Math.round(earnDefiUSD * 100) / 100,
        subtotalUSD: Math.round(subtotalUSD * 100) / 100,
        valuationUSD: Math.round(valuationUSD * 100) / 100,
      },
      totalUSD: Math.round(totalUSD * 100) / 100,
      topCoinsUSD,
      timestamp: Date.now(),
      note:
        "totalUSD는 OKX 공식 valuation(USD)을 우선 사용. Savings/DeFi는 USDT만 1:1 USD로 가산(타 코인은 추후 가격 오라클 연동 시 확장).",
    };

    if (debug) {
      payload._debug = {
        account_balance: rawAccount,
        asset_balances: rawFunding,
        savings_balance: rawSavings,
        defi_positions: rawDefi,
        asset_valuation: rawValuation,
      };
    }

    res.status(200).json(payload);
  } catch (e) {
    const status = e?._client ? 400 : 500;
    res.status(status).json({ ok: false, error: e.message });
  }
}