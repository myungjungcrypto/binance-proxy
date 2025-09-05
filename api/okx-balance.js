// api/okx-balance.js
import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";

function okxSign({ ts, method, path, body = "", secret }) {
  const prehash = `${ts}${method}${path}${body}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function okxFetch({ method = "GET", path, params, bodyObj, debug }) {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    const err = "Missing OKX API credentials";
    if (debug) return { _error: err };
    throw new Error(err);
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

  try {
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
    // OKX v5: code === "0" 이 정상
    if (!r.ok || String(json?.code) !== "0") {
      const msg = json?.msg || `HTTP ${r.status}`;
      if (debug) return { _error: `OKX ${path} error: ${msg}`, _raw: json };
      throw new Error(`OKX ${path} error: ${msg}`);
    }
    return json?.data ?? [];
  } catch (e) {
    if (debug) return { _error: e.message };
    throw e;
  }
}

const toNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

function sumUSDMapToList(usdMap) {
  const list = [];
  for (const [ccy, usd] of Object.entries(usdMap)) {
    if (usd !== 0) list.push({ ccy, usd });
  }
  return list.sort((a, b) => b.usd - a.usd);
}

export default async function handler(req, res) {
  const debug = req.query?.debug === "1" || req.query?.debug === "true";
  const diag = {}; // 디버그 수집
  try {
    const mode = "Advanced / Multi-Currency";

    // 1) Trading/Unified
    let tradingCoins = [];
    let tradingUSD = 0;
    {
      const acc = await okxFetch({
        method: "GET",
        path: "/api/v5/account/balance",
        debug,
      });
      if (acc?._error) {
        diag.account_balance = acc;
      } else {
        const a = acc?.[0] || {};
        tradingUSD = toNum(a.totalEq);
        const usdMap = {};
        for (const d of a.details || []) {
          const ccy = d.ccy;
          const eqUsd = toNum(d.eqUsd ?? d.usdValue ?? 0);
          if (eqUsd) usdMap[ccy] = (usdMap[ccy] || 0) + eqUsd;
        }
        tradingCoins = sumUSDMapToList(usdMap);
      }
    }

    // 2) Funding
    let fundingCoins = [];
    let fundingUSD = 0;
    {
      const fund = await okxFetch({
        method: "GET",
        path: "/api/v5/asset/balances",
        debug,
      });
      if (fund?._error) {
        diag.asset_balances = fund;
      } else {
        const usdMap = {};
        for (const d of fund || []) {
          const ccy = d.ccy;
          const usd = toNum(d.usdVal ?? d.usdValue ?? d.eqUsd ?? 0);
          if (usd) {
            usdMap[ccy] = (usdMap[ccy] || 0) + usd;
            fundingUSD += usd;
          }
        }
        fundingCoins = sumUSDMapToList(usdMap);
      }
    }

    // 3) Earn - Savings (가능 시)
    let earnSavingsUSD = 0;
    let earnSavingsCoins = [];
    {
      const sav = await okxFetch({
        method: "GET",
        path: "/api/v5/finance/savings/balance",
        debug,
      });
      if (sav?._error) {
        diag.finance_savings_balance = sav;
      } else {
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
      }
    }

    // 4) Earn - Staking/DeFi (가능 시)
    let earnDefiUSD = 0;
    let earnDefiCoins = [];
    {
      const defi = await okxFetch({
        method: "GET",
        path: "/api/v5/finance/staking-defi/positions",
        debug,
      });
      if (defi?._error) {
        diag.finance_staking_defi_positions = defi;
      } else {
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
      }
    }

    // 5) 자산평가 (있으면 최우선)
    let valuationUSD = 0;
    {
      const val = await okxFetch({
        method: "GET",
        path: "/api/v5/asset/asset-valuation",
        params: { ccy: "USD" },
        debug,
      });
      if (val?._error) {
        diag.asset_valuation = val;
      } else {
        valuationUSD = toNum(val?.[0]?.totalBal ?? 0);
      }
    }

    const mergedMap = {};
    for (const list of [tradingCoins, fundingCoins, earnSavingsCoins, earnDefiCoins]) {
      for (const { ccy, usd } of list) {
        mergedMap[ccy] = (mergedMap[ccy] || 0) + usd;
      }
    }
    const topCoinsUSD = sumUSDMapToList(mergedMap).slice(0, 5);

    const subtotal =
      tradingUSD + fundingUSD + earnSavingsUSD + earnDefiUSD;

    const totalUSD = valuationUSD > 0 ? valuationUSD : subtotal;

    const out = {
      mode,
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
    };

    if (debug) out.debug = diag;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}