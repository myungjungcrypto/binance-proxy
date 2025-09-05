// api/okx-balance.js
import crypto from "crypto";

// ---- OKX 서명/호출 유틸 ----
function sign(message, secret) {
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

function isoTime() {
  return new Date().toISOString();
}

async function okxGet(path, params, { key, secret, passphrase }) {
  const qs = params
    ? "?" +
      Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const url = `https://www.okx.com${path}${qs}`;

  const ts = isoTime();
  const prehash = ts + "GET" + path + (qs || "");
  const signature = sign(prehash, secret);

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": key,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": passphrase,
    },
  });

  const rawText = await r.text();
  let json;
  try { json = JSON.parse(rawText); } catch { /* noop */ }

  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${rawText}`);
  if (!json || json.code !== "0") {
    throw new Error(`OKX ${path} error: code=${json?.code} msg=${json?.msg || rawText}`);
  }
  return json.data || [];
}

// ---- 개별 호출 ----
// 1) 계정 모드 확인 (Simple / Portfolio / Advanced)
async function fetchAccountConfig(auth) {
  const data = await okxGet("/api/v5/account/config", null, auth);
  const cfg = data[0] || {};
  // acctLv: 1(Simple), 2(Portfolio), 3(Portfolio Margin), 4(Simplified?), 5(Enhanced / Advanced)
  // mgnMode: cross/isolated, posMode 등
  return {
    acctLv: cfg.acctLv,
    mgnMode: cfg.mgnMode,
    uid: cfg.uid,
  };
}

// 2) Trading(=Trade 계정, 기존 spot/margin/derivatives) 잔고 요약 (USD)
//    OKX는 /account/asset-valuation 으로 USD 평가액을 바로 줍니다.
async function fetchTradingValuationUSD(auth) {
  const data = await okxGet("/api/v5/account/asset-valuation", { ccy: "USD" }, auth);
  // data[0].totalBal 는 계정 총 평가액(USD 기준)
  const t = data[0] || {};
  const v = Number(t.totalBal || "0");
  return Number.isFinite(v) ? v : 0;
}

// 3) 지갑별 상세(코인별 USD) — 상위 코인 브레이크다운용
async function fetchAssetBalances(auth) {
  const list = await okxGet("/api/v5/asset/balances", null, auth);
  // 각 항목: { ccy, bal, availBal, frozenBal, ... , usdVal }
  return list.map((x) => ({
    ccy: x.ccy,
    usd: Number(x.usdVal || "0"),
  }));
}

// 4) Earn - Savings(유동성 저축) 잔고 (USDT 위주 집계)
//    공식 엔드포인트: /api/v5/finance/savings/balance
//    - 계정 권한/리전에 따라 404가 날 수 있어 try/catch 후 0 처리
async function fetchSavingsUSDT(auth) {
  try {
    const data = await okxGet("/api/v5/finance/savings/balance", null, auth);
    // 예시 항목: { ccy: 'USDT', amt: '17800', rate: '...' ... }
    let usdt = 0;
    for (const it of data) {
      if ((it.ccy || "").toUpperCase() === "USDT") {
        const amt = Number(it.amt || "0");
        if (Number.isFinite(amt)) usdt += amt;
      }
    }
    return usdt; // USDT 수량 == USD
  } catch {
    return 0;
  }
}

// 5) Earn - DeFi Staking/On-chain Earn (USDT 위주)
//    엔드포인트는 계정 상태에 따라 다를 수 있어 두 가지 경로 시도 후 실패 시 0 처리
async function fetchDefiUSDT(auth) {
  // 후보 1
  try {
    const data = await okxGet("/api/v5/finance/staking-defi/positions", null, auth);
    let usdt = 0;
    for (const it of data) {
      if ((it.ccy || "").toUpperCase() === "USDT") {
        const amt = Number(it.amt || it.investAmt || "0");
        if (Number.isFinite(amt)) usdt += amt;
      }
    }
    if (usdt > 0) return usdt;
  } catch { /* try alt */ }

  // 후보 2 (활성 주문 목록)
  try {
    const data = await okxGet("/api/v5/finance/staking-defi/orders-active", null, auth);
    let usdt = 0;
    for (const it of data) {
      if ((it.ccy || "").toUpperCase() === "USDT") {
        const amt = Number(it.amt || it.investAmt || "0");
        if (Number.isFinite(amt)) usdt += amt;
      }
    }
    return usdt;
  } catch {
    return 0;
  }
}

// ---- 핸들러 ----
export default async function handler(req, res) {
  try {
    const key = process.env.OKX_API_KEY;
    const secret = process.env.OKX_API_SECRET;
    const passphrase = process.env.OKX_API_PASSPHRASE;

    if (!key || !secret || !passphrase) {
      return res.status(500).json({ ok: false, error: "Missing OKX API credentials" });
    }

    const auth = { key, secret, passphrase };
    const cfg = await fetchAccountConfig(auth);

    // Trading(거래/파생/현물) 총 USD 평가액
    const tradingUSD = await fetchTradingValuationUSD(auth);

    // 상위 코인 브레이크다운(거래/자산 계정에서의 USD 평가)
    const assetCoins = await fetchAssetBalances(auth);
    const topCoinsUSD = assetCoins
      .filter((x) => Number.isFinite(x.usd) && x.usd !== 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);

    // Earn - Savings/DeFi (USDT는 1:1로 USD에 합산)
    const earnSavingsUSDT = await fetchSavingsUSDT(auth);
    const earnDefiUSDT = await fetchDefiUSDT(auth);

    const fundingUSD = 0; // (필요하면 /asset/balances?type=funding 등 추가 분해)
    const earnSavingsUSD = earnSavingsUSDT; // 1 USDT = 1 USD
    const earnDefiUSD = earnDefiUSDT;       // 1 USDT = 1 USD

    const subtotalUSD = tradingUSD + fundingUSD + earnSavingsUSD + earnDefiUSD;

    // 결과
    res.status(200).json({
      mode:
        cfg.acctLv === "1"
          ? "Simple / Single-Currency"
          : cfg.acctLv === "5"
          ? "Advanced / Multi-Currency"
          : `acctLv=${cfg.acctLv || "?"}`,
      totals: {
        tradingUSD: Math.round(tradingUSD * 100) / 100,
        fundingUSD: Math.round(fundingUSD * 100) / 100,
        earnSavingsUSD: Math.round(earnSavingsUSD * 100) / 100,
        earnDefiUSD: Math.round(earnDefiUSD * 100) / 100,
        subtotalUSD: Math.round(subtotalUSD * 100) / 100,
      },
      totalUSD: Math.round(subtotalUSD * 100) / 100,
      topCoinsUSD,
      timestamp: Date.now(),
      note:
        "Earn(Savings/DeFi)의 USDT는 1:1로 USD로 집계. 비(非)USDT Earn은 가격 오라클 연동 시 확장 가능.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}