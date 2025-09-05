// api/okx-balance.js
import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";

function okxSign(timestamp, method, path, query = "", body = "", secret) {
  const prehash = timestamp + method.toUpperCase() + path + (query || "") + (body || "");
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function okxFetch({ path, method = "GET", query = "", bodyObj = null, creds }) {
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig = okxSign(ts, method, path, query, body, creds.secret);

  const url = OKX_BASE + path + (query || "");
  const r = await fetch(url, {
    method,
    headers: {
      "OK-ACCESS-KEY": creds.key,
      "OK-ACCESS-SIGN": sig,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": creds.passphrase,
      "OK-ACCESS-PROJECT": "",       // 필요없음
      "Content-Type": "application/json",
      "x-simulated-trading": "0"
    },
    body: body || undefined
  });

  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  return { ok: r.ok, status: r.status, json };
}

function sumUSD(list, picker) {
  let s = 0;
  for (const it of list) {
    const v = picker(it);
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

export default async function handler(req, res) {
  try {
    const key = process.env.OKX_API_KEY;
    const secret = process.env.OKX_API_SECRET;
    const passphrase = process.env.OKX_API_PASSPHRASE;
    if (!key || !secret || !passphrase) {
      return res.status(400).json({ ok: false, error: "Missing OKX API credentials" });
    }
    const debugMode = req.query.debug === "1" || req.query.debug === "true";

    const creds = { key, secret, passphrase };
    const debug = { steps: [] };

    // 1) 계정 모드 확인 (Advanced / Multi-Currency)
    const acct = await okxFetch({
      path: "/api/v5/account/config",
      creds
    });
    debug.steps.push({ step: "account/config", status: acct.status, data: acct.json });
    const mode = (() => {
      const r = acct.json?.data?.[0];
      if (!r) return "Unknown";
      // acctLevel=2 가 Advanced, posMode 등 참고용
      return (r.acctLv === "2" ? "Advanced" : "Simple") + " / " + (r.multiCcyMargin === "true" ? "Multi-Currency" : "Single-Currency");
    })();

    // 2) Trading/Portfolio 잔고 (계정 총 평가액)
    // okx v5: /api/v5/account/balance  (eqUsd 제공)
    const accountBal = await okxFetch({
      path: "/api/v5/account/balance",
      creds
    });
    debug.steps.push({ step: "account/balance", status: accountBal.status, data: accountBal.json });

    let tradingUSD = 0;
    let coinsFromAccount = [];
    if (accountBal.ok && accountBal.json?.data?.[0]) {
      const d = accountBal.json.data[0];
      tradingUSD = Number(d?.totalEq) || 0; // 총 평가(USD 등가). OKX는 통화기준 eq 필드가 있을 수 있음
      // 코인별 브레이크다운: eqUsd가 없으면 eq(기준자산 등가)만 있을 수 있어 보조적으로 사용
      coinsFromAccount = Array.isArray(d.details) ? d.details.map(it => ({
        ccy: it.ccy,
        usd: Number(it.eqUsd ?? it.eq ?? 0)
      })) : [];
    }

    // 3) Funding(자금) 지갑
    // /api/v5/asset/balances  -> 각 코인의 bal, availBal, frozenBal, eqUsd
    const funding = await okxFetch({
      path: "/api/v5/asset/balances",
      creds
    });
    debug.steps.push({ step: "asset/balances", status: funding.status, data: funding.json });

    let fundingUSD = 0;
    let coinsFromFunding = [];
    if (funding.ok && Array.isArray(funding.json?.data)) {
      coinsFromFunding = funding.json.data.map(x => ({
        ccy: x.ccy,
        usd: Number(x.eqUsd ?? 0),
      }));
      fundingUSD = sumUSD(coinsFromFunding, it => it.usd);
    }

    // 4) Savings(간단 예치) 잔고
    // /api/v5/finance/savings/balance  -> data: [{ccy, amt, earn, ...}] (eqUsd가 직접 없으면 환율필드가 없어서 USD 합산은 불가할 수도)
    // 여기서는 USD 환산이 없는 경우, 일단 건수/원시 데이터만 참고하거나 코인만 추려둔다.
    let savingsUSD = 0;
    let coinsFromSavings = [];
    const savings = await okxFetch({
      path: "/api/v5/finance/savings/balance",
      creds
    });
    debug.steps.push({ step: "finance/savings/balance", status: savings.status, data: savings.json });

    if (savings.ok && Array.isArray(savings.json?.data)) {
      // savings API는 통상 USD 환산을 직접 주지 않는다. 보수적으로 0으로 두고 코인 목록만 참고.
      coinsFromSavings = savings.json.data.map(x => ({ ccy: x.ccy, amt: Number(x.amt ?? 0) }));
      // 원한다면 가격 오라클 붙여 USD 환산 가능(추후 확장)
    }

    // 5) Staking/DeFi(락업형) 활성 포지션
    // 올바른 엔드포인트: /api/v5/finance/staking-defi/orders-active
    let defiUSD = 0;
    let coinsFromDefi = [];
    const defi = await okxFetch({
      path: "/api/v5/finance/staking-defi/orders-active",
      creds
    });
    debug.steps.push({ step: "finance/staking-defi/orders-active", status: defi.status, data: defi.json });

    if (defi.ok && Array.isArray(defi.json?.data)) {
      // 이쪽도 보통 원화 환산이 직접 없을 수 있다. 여기서는 코인/수량만 보관.
      coinsFromDefi = defi.json.data.map(x => ({
        ccy: x.ccy || x.earnCcy || "UNKNOWN",
        amt: Number(x.investedAmt ?? x.subsAmt ?? 0)
      }));
    }

    // 6) 합산 로직
    // - tradingUSD: account/balance의 totalEq 사용 (이미 USD 등가)
    // - fundingUSD: asset/balances의 eqUsd 합
    // - savings/defi는 USD환산 필드가 없으면 0으로 두고, 추후 오라클로 확장 가능
    const subtotalUSD = (Number(tradingUSD) || 0) + (Number(fundingUSD) || 0) + (Number(savingsUSD) || 0) + (Number(defiUSD) || 0);

    // 상위 코인 브레이크다운: account(details) + funding(eqUsd 있는 곳)만으로 상위 5개
    const merged = [];
    for (const it of coinsFromAccount) if (it.usd) merged.push({ ccy: it.ccy, usd: it.usd });
    for (const it of coinsFromFunding) if (it.usd) merged.push({ ccy: it.ccy, usd: it.usd });

    // 같은 코인 합치기
    const byCcy = {};
    for (const it of merged) {
      byCcy[it.ccy] = (byCcy[it.ccy] || 0) + (Number(it.usd) || 0);
    }
    const topCoinsUSD = Object.entries(byCcy)
      .map(([ccy, usd]) => ({ ccy, usd }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);

    const out = {
      mode,
      totals: {
        tradingUSD: Math.round(tradingUSD * 100) / 100,
        fundingUSD: Math.round(fundingUSD * 100) / 100,
        earnSavingsUSD: Math.round(savingsUSD * 100) / 100,
        earnDefiUSD: Math.round(defiUSD * 100) / 100,
        subtotalUSD: Math.round(subtotalUSD * 100) / 100
      },
      // subtotalUSD가 사실상 '현재 알 수 있는 USD 합'임
      totalUSD: Math.round(subtotalUSD * 100) / 100,
      topCoinsUSD,
      timestamp: Date.now(),
      note: "Savings/DeFi는 USD 환산 필드가 없어 0으로 집계됨(추후 가격 오라클 연결로 확장 가능)."
    };

    if (debugMode) out.debug = debug;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}