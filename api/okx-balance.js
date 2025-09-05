// api/okx-balance.js
import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";

// ---- OKX signature helper ----
function okxSign({ ts, method, path, body = "", secret }) {
  const prehash = `${ts}${method}${path}${body}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function okxFetch({ method = "GET", path, params, bodyObj }) {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    throw new Error("Missing OKX API credentials");
  }

  const qs = params
    ? "?" +
      Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";

  const url = OKX_BASE + path + qs;
  const ts = new Date().toISOString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sign = okxSign({ ts, method, path: path + qs, body: bodyStr, secret });

  const r = await fetch(url, {
    method,
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok || json?.code?.toString?.() !== "0") {
    // NOTE: OKX v5는 code==="0"이 정상
    const msg = json?.msg || `HTTP ${r.status}`;
    throw new Error(`OKX ${path} error: ${msg}`);
  }
  return json?.data ?? [];
}

// 안전 파서
const toNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

// 코인 USD 합산
function sumUSDMapToList(usdMap) {
  const list = [];
  for (const [ccy, usd] of Object.entries(usdMap)) {
    if (usd !== 0) list.push({ ccy, usd });
  }
  return list.sort((a, b) => b.usd - a.usd);
}

export default async function handler(req, res) {
  try {
    const mode = "Advanced / Multi-Currency"; // 명확히 표기

    // 1) Trading/Unified 계정 (기존: /api/v5/account/balance)
    let tradingCoins = [];
    let tradingUSD = 0;
    try {
      const acc = await okxFetch({
        method: "GET",
        path: "/api/v5/account/balance",
      });
      // acc: [{ totalEq, details: [{ ccy, cashBal, eqUsd? ... }] }]
      const a = acc?.[0] || {};
      tradingUSD = toNum(a.totalEq); // USD 평가 총합
      // breakdown (가능한 필드만 사용)
      const usdMap = {};
      for (const d of a.details || []) {
        const ccy = d.ccy;
        const eqUsd = toNum(d.eqUsd ?? d.usdValue ?? 0);
        if (eqUsd) usdMap[ccy] = (usdMap[ccy] || 0) + eqUsd;
      }
      tradingCoins = sumUSDMapToList(usdMap);
    } catch (e) {
      // 무시하고 진행 (어떤 계정은 없을 수 있음)
    }

    // 2) Funding 계정 (/api/v5/asset/balances)
    let fundingCoins = [];
    let fundingUSD = 0;
    try {
      const fund = await okxFetch({
        method: "GET",
        path: "/api/v5/asset/balances",
      });
      // fund: [{ ccy, bal, frozenBal, availBal, ... , usdVal? }]
      const usdMap = {};
      for (const d of fund || []) {
        const ccy = d.ccy;
        // 일부 응답은 usdVal 또는 eqUsd 형태가 없을 수 있음
        const usd = toNum(d.usdVal ?? d.usdValue ?? d.eqUsd ?? 0);
        if (usd) {
          usdMap[ccy] = (usdMap[ccy] || 0) + usd;
          fundingUSD += usd;
        }
      }
      fundingCoins = sumUSDMapToList(usdMap);
    } catch (e) {
      // 무시
    }

    // 3) Earn(수익) - Savings 잔액 (가능 시)
    // 실제 엔드포인트 명은 계정 상태에 따라 다를 수 있어 try-catch로 유연 처리
    let earnSavingsUSD = 0;
    let earnSavingsCoins = [];
    try {
      // 참고: OKX가 savings 관련 데이터를 별도 엔드포인트로 제공하는 경우가 있음.
      // 최신 스펙에서 달라질 수 있으므로 실패해도 전체 로직은 계속 진행.
      const sav = await okxFetch({
        method: "GET",
        path: "/api/v5/finance/savings/balance", // 이용 불가 시 에러
      });
      // 예시 가정: [{ ccy, amt, usdVal }]
      const usdMap = {};
      for (const d of sav || []) {
        const ccy = d.ccy;
        const usd = toNum(d.usdVal ?? d.usdValue ?? d.eqUsd ?? 0);
        if (usd) {
          usdMap[ccy] = (usdMap[ccy] || 0) + usd;
          earnSavingsUSD += usd;
        }
      }
      earnSavingsCoins = sumUSDMapToList(usdMap);
    } catch (e) {
      // 엔드포인트 미지원/무포지션이면 조용히 패스
    }

    // 4) Earn(수익) - Staking/Defi 등 (가능 시)
    let earnDefiUSD = 0;
    let earnDefiCoins = [];
    try {
      const defi = await okxFetch({
        method: "GET",
        path: "/api/v5/finance/staking-defi/positions", // 가용 시
      });
      // 예시 가정: [{ ccy, principalUsd, pnlUsd }]
      const usdMap = {};
      for (const d of defi || []) {
        const ccy = d.ccy;
        const usd =
          toNum(d.principalUsd ?? 0) +
          toNum(d.pnlUsd ?? 0) +
          toNum(d.usdVal ?? d.usdValue ?? d.eqUsd ?? 0);
        if (usd) {
          usdMap[ccy] = (usdMap[ccy] || 0) + usd;
          earnDefiUSD += usd;
        }
      }
      earnDefiCoins = sumUSDMapToList(usdMap);
    } catch (e) {
      // 엔드포인트 미지원/무포지션이면 패스
    }

    // 5) OKX 자산평가(모든 계정 통합) — 가능하면 이 값을 최종으로 신뢰
    // https://www.okx.com/docs-v5/ (Asset Valuation)
    let valuationUSD = 0;
    try {
      const val = await okxFetch({
        method: "GET",
        path: "/api/v5/asset/asset-valuation",
        params: { ccy: "USD" },
      });
      // val: [{ totalBal, uTime, ... }]
      valuationUSD = toNum(val?.[0]?.totalBal ?? 0);
    } catch (e) {
      // 미지원 시 무시
    }

    // 브레이크다운(상위 5개): trading + funding + earn(savings+defi)에서 큰 순
    const mergedMap = {};
    for (const list of [tradingCoins, fundingCoins, earnSavingsCoins, earnDefiCoins]) {
      for (const { ccy, usd } of list) {
        mergedMap[ccy] = (mergedMap[ccy] || 0) + usd;
      }
    }
    const topCoinsUSD = sumUSDMapToList(mergedMap).slice(0, 5);

    const subtotal =
      tradingUSD + fundingUSD + earnSavingsUSD + earnDefiUSD;

    // 최종 totalUSD: 자산평가가 있으면 우선 사용, 없으면 합산값 사용
    const totalUSD = valuationUSD > 0 ? valuationUSD : subtotal;

    return res.status(200).json({
      mode,
      // 세부 합계도 같이 보여줘서 디버깅/검증 용이
      totals: {
        tradingUSD: Math.round(tradingUSD * 100) / 100,
        fundingUSD: Math.round(fundingUSD * 100) / 100,
        earnSavingsUSD: Math.round(earnSavingsUSD * 100) / 100,
        earnDefiUSD: Math.round(earnDefiUSD * 100) / 100,
        subtotalUSD: Math.round(subtotal * 100) / 100,
        valuationUSD: Math.round(valuationUSD * 100) / 100,
      },
      totalUSD: Math.round(totalUSD * 100) / 100,
      topCoinsUSD,
      timestamp: Date.now(),
      note:
        valuationUSD > 0
          ? "totalUSD uses OKX asset valuation (USD)."
          : "totalUSD is the sum of trading+funding+earn.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}