// api/binance-btc-summary.js
import crypto from "crypto";

/**
 * BTC 개수 집계(계정 선택 가능):
 * - Spot: /sapi/v3/asset/getUserAsset (asset=BTC)
 * - Funding: /sapi/v1/asset/getFundingAsset (asset=BTC)
 * - Cross Margin: /sapi/v1/margin/account (userAssets[].netAsset for BTC)
 * - Isolated Margin: (미집계, 필요 시 확장)
 * - Earn:
 *   1) Simple Earn Flexible:  /sapi/v1/simple-earn/flexible/position?asset=BTC
 *   2) Simple Earn Locked:    /sapi/v1/simple-earn/locked/position?asset=BTC
 *   3) (백업) Lending Union:  /sapi/v1/lending/union/account
 *   4) (백업) Flexible(Savings): /sapi/v1/lending/daily/token/position?asset=BTC
 *   5) (백업) Locked(Savings):   /sapi/v1/lending/project/position/list?asset=BTC&type=ALL
 *
 * Futures (USDⓈ-M):
 * - /papi/v1/um/positionRisk (PM), 실패 시 /fapi/v2/positionRisk
 *
 * ENV:
 * - 기본: BINANCE_API_KEY / BINANCE_SECRET_KEY
 * - acct=2: BINANCE2_API_KEY / BINANCE2_SECRET_KEY
 */

export default async function handler(req, res) {
  try {
    // ✅ 계정 선택
    const useAcct2 = (req.query?.acct === "2");
    const apiKey    = useAcct2 ? process.env.BINANCE2_API_KEY    : process.env.BINANCE_API_KEY;
    const secretKey = useAcct2 ? process.env.BINANCE2_SECRET_KEY : process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }

    const recv = 60000;
    const sign = (q) => crypto.createHmac("sha256", secretKey).update(q).digest("hex");
    const headers = {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // 공용 호출자
    const callGET = async (base, path, paramsObj = {}) => {
      const p = new URLSearchParams({ recvWindow: String(recv), timestamp: String(Date.now()), ...paramsObj });
      const q = p.toString();
      const sig = sign(q);
      const url = `${base}${path}?${q}&signature=${sig}`;
      const r = await fetch(url, { headers });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: t, url };
    };
    const callPOST = async (base, path, paramsObj = {}) => {
      const p = new URLSearchParams({ recvWindow: String(recv), timestamp: String(Date.now()), ...paramsObj });
      const body = p.toString();
      const sig = sign(body);
      const url = `${base}${path}?signature=${sig}`;
      const r = await fetch(url, { method: "POST", headers, body });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: t, url };
    };

    // 숫자 파서
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };

    // ---- 1) Spot BTC ----
    const spotR = await callPOST("https://api.binance.com", "/sapi/v3/asset/getUserAsset", { asset: "BTC" });
    let spotBTC = 0;
    if (Array.isArray(spotR.json)) {
      const row = spotR.json.find((x) => String(x.asset) === "BTC");
      if (row) {
        spotBTC = n(row.free) + n(row.locked);
      }
    }

    // ---- 2) Funding BTC ----
    const fundingR = await callPOST("https://api.binance.com", "/sapi/v1/asset/getFundingAsset", { asset: "BTC" });
    let fundingBTC = 0;
    if (Array.isArray(fundingR.json)) {
      for (const it of fundingR.json) {
        if (String(it.asset) === "BTC") {
          for (const v of [it.balance, it.free, it.locked, it.freeze]) {
            const vv = n(v);
            if (vv > 0) fundingBTC += vv;
          }
        }
      }
    }

    // ---- 3) Cross Margin BTC ----
    const crossR = await callGET("https://api.binance.com", "/sapi/v1/margin/account");
    let marginCrossBTC = 0;
    if (crossR.json && Array.isArray(crossR.json.userAssets)) {
      const row = crossR.json.userAssets.find((x) => String(x.asset) === "BTC");
      if (row) marginCrossBTC = n(row.netAsset);
    }

    // ---- 4) Isolated Margin BTC (옵션: 현재 0) ----
    let marginIsoBTC = 0;
    // 필요 시:
    // const isoR = await callGET("https://api.binance.com", "/sapi/v1/margin/isolated/account", { symbols: "all" });
    // isoR.json.assets[].{baseAsset,quoteAsset}.asset==="BTC" 의 netAsset 합산

    // ---- 5) Earn BTC (여러 API를 시도해 합산) ----
    const getEarnBTC = async () => {
      let total = 0;

      // 5-1) Simple Earn Flexible
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/simple-earn/flexible/position", { asset: "BTC" });
        if (r.ok && Array.isArray(r.json?.rows || r.json)) {
          const rows = r.json.rows || r.json; // 일부 계정은 rows 없이 배열로 줄 수도 있음
          for (const it of rows) {
            // amount/totalAmount/purchasedAmount 중 유효값 합산
            total += n(it.totalAmount ?? it.amount ?? it.purchasedAmount);
          }
        }
      }
      // 5-2) Simple Earn Locked
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/simple-earn/locked/position", { asset: "BTC" });
        if (r.ok && Array.isArray(r.json?.rows || r.json)) {
          const rows = r.json.rows || r.json;
          for (const it of rows) {
            total += n(it.totalAmount ?? it.amount ?? it.purchasedAmount);
          }
        }
      }
      // 5-3) (백업) Lending Union Account
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/union/account");
        // 예상 구조: { totalAmountInBTC: "...", positionAmountVos: [{ asset, amount }, ...] }
        if (r.ok && r.json) {
          // positionAmountVos에 BTC가 있으면 합산
          const list = r.json.positionAmountVos;
          if (Array.isArray(list)) {
            for (const it of list) {
              if (String(it?.asset) === "BTC") total += n(it?.amount);
            }
          }
        }
      }
      // 5-4) (백업) Flexible Savings
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/daily/token/position", { asset: "BTC" });
        if (r.ok && Array.isArray(r.json)) {
          for (const it of r.json) {
            total += n(it?.freeAmount) + n(it?.lockedAmount) + n(it?.totalAmount);
          }
        }
      }
      // 5-5) (백업) Locked Savings
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/project/position/list", { asset: "BTC", type: "ALL" });
        if (r.ok && Array.isArray(r.json)) {
          for (const it of r.json) {
            total += n(it?.amount) + n(it?.lotAmount);
          }
        }
      }

      return +total.toFixed(8);
    };

    const earnBTC = await getEarnBTC();

    // ---- 6) USDⓈ-M BTC 포지션 (PM→PAPI, 아니면 FAPI) ----
    const getUsdmBtcPos = async () => {
      const papi = await callGET("https://papi.binance.com", "/papi/v1/um/positionRisk");
      let list = Array.isArray(papi.json) && papi.ok ? papi.json : null;
      if (!list) {
        const fapi = await callGET("https://fapi.binance.com", "/fapi/v2/positionRisk");
        list = Array.isArray(fapi.json) && fapi.ok ? fapi.json : [];
      }
      let sum = 0;
      for (const p of list) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("BTC")) continue; // BTCUSDT, BTCUSDC 등
        const amt = n(p.positionAmt);
        if (amt !== 0) sum += Math.abs(amt);
      }
      return +sum.toFixed(8);
    };

    const usdM_BTCpos = await getUsdmBtcPos();

    // 합계
    const walletsTotalBTC = +(
      spotBTC + fundingBTC + marginCrossBTC + marginIsoBTC + earnBTC
    ).toFixed(8);

    return res.status(200).json({
      account: useAcct2 ? "acct2" : "acct1",
      spot: {
        spotBTC: +spotBTC.toFixed(8),
        fundingBTC: +fundingBTC.toFixed(8),
        marginCrossBTC: +marginCrossBTC.toFixed(8),
        marginIsoBTC: +marginIsoBTC.toFixed(8), // 현재 0
        earnBTC: +earnBTC.toFixed(8),           // ✅ Earn 포함
        walletsTotalBTC,                        // ✅ Earn 포함 총합
      },
      futures: { usdM_BTCpos },
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}