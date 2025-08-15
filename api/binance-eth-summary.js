// api/binance-eth-summary.js
import crypto from "crypto";

/**
 * ETH 개수 집계(계정 선택 가능):
 * - Spot: /sapi/v3/asset/getUserAsset (asset=ETH)
 * - Funding: /sapi/v1/asset/getFundingAsset (asset=ETH)
 * - Cross Margin: /sapi/v1/margin/account (userAssets[].netAsset for ETH)
 * - Isolated Margin: (현재 0, 필요시 확장)
 * - Earn(모두 합산):
 *   1) Simple Earn Flexible:  /sapi/v1/simple-earn/flexible/position?asset=ETH
 *   2) Simple Earn Locked:    /sapi/v1/simple-earn/locked/position?asset=ETH
 *   3) (백업) Lending Union:  /sapi/v1/lending/union/account
 *   4) (백업) Flexible(Savings): /sapi/v1/lending/daily/token/position?asset=ETH
 *   5) (백업) Locked(Savings):   /sapi/v1/lending/project/position/list?asset=ETH&type=ALL
 *
 * Futures (USDⓈ-M):
 * - PM이면 /papi/v1/um/positionRisk, 아니면 /fapi/v2/positionRisk
 * - ✅ 선물 수량은 절대값 합이 아니라 "순 수량(net)"(롱−숏)을 합산하여 반환(usdM_ETHnetQty)
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
    const num = (v) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };

    // ---- 1) Spot ETH ----
    const spotR = await callPOST("https://api.binance.com", "/sapi/v3/asset/getUserAsset", { asset: "ETH" });
    let spotETH = 0;
    if (Array.isArray(spotR.json)) {
      const row = spotR.json.find((x) => String(x.asset) === "ETH");
      if (row) spotETH = num(row.free) + num(row.locked);
    }

    // ---- 2) Funding ETH ----
    const fundingR = await callPOST("https://api.binance.com", "/sapi/v1/asset/getFundingAsset", { asset: "ETH" });
    let fundingETH = 0;
    if (Array.isArray(fundingR.json)) {
      for (const it of fundingR.json) {
        if (String(it.asset) === "ETH") {
          for (const v of [it.balance, it.free, it.locked, it.freeze]) {
            const vv = num(v);
            if (vv > 0) fundingETH += vv;
          }
        }
      }
    }

    // ---- 3) Cross Margin ETH (netAsset) ----
    const crossR = await callGET("https://api.binance.com", "/sapi/v1/margin/account");
    let marginCrossETH = 0;
    if (crossR.json && Array.isArray(crossR.json.userAssets)) {
      const row = crossR.json.userAssets.find((x) => String(x.asset) === "ETH");
      if (row) marginCrossETH = num(row.netAsset);
    }

    // ---- 4) Isolated Margin ETH (옵션: 현재 0) ----
    let marginIsoETH = 0;
    // 필요 시 isolated 전체 symbols=all 스캔로 확장 가능

    // ---- 5) Earn ETH (여러 API를 시도해 합산) ----
    const getEarnETH = async () => {
      let total = 0;

      // Simple Earn Flexible
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/simple-earn/flexible/position", { asset: "ETH" });
        if (r.ok && Array.isArray(r.json?.rows || r.json)) {
          const rows = r.json.rows || r.json;
          for (const it of rows) total += num(it.totalAmount ?? it.amount ?? it.purchasedAmount);
        }
      }
      // Simple Earn Locked
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/simple-earn/locked/position", { asset: "ETH" });
        if (r.ok && Array.isArray(r.json?.rows || r.json)) {
          const rows = r.json.rows || r.json;
          for (const it of rows) total += num(it.totalAmount ?? it.amount ?? it.purchasedAmount);
        }
      }
      // (백업) Lending Union Account
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/union/account");
        const list = r.json?.positionAmountVos;
        if (r.ok && Array.isArray(list)) {
          for (const it of list) if (String(it?.asset) === "ETH") total += num(it?.amount);
        }
      }
      // (백업) Flexible Savings
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/daily/token/position", { asset: "ETH" });
        if (r.ok && Array.isArray(r.json)) {
          for (const it of r.json) total += num(it?.freeAmount) + num(it?.lockedAmount) + num(it?.totalAmount);
        }
      }
      // (백업) Locked Savings
      {
        const r = await callGET("https://api.binance.com", "/sapi/v1/lending/project/position/list", { asset: "ETH", type: "ALL" });
        if (r.ok && Array.isArray(r.json)) {
          for (const it of r.json) total += num(it?.amount) + num(it?.lotAmount);
        }
      }

      return +total.toFixed(8);
    };

    const earnETH = await getEarnETH();

    // ---- 6) USDⓈ-M ETH 포지션 (순 수량 NET 합산) ----
    const getUsdmEthNetQty = async () => {
      // PM(포트폴리오) 우선 → 실패 시 FAPI
      const papi = await callGET("https://papi.binance.com", "/papi/v1/um/positionRisk");
      let list = Array.isArray(papi.json) && papi.ok ? papi.json : null;
      if (!list) {
        const fapi = await callGET("https://fapi.binance.com", "/fapi/v2/positionRisk");
        list = Array.isArray(fapi.json) && fapi.ok ? fapi.json : [];
      }
      let net = 0; // 롱(+) − 숏(−)의 순 합
      for (const p of list) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("ETH")) continue; // ETHUSDT, ETHUSDC 등
        const amt = num(p.positionAmt);
        if (amt !== 0) net += amt; // 절대값 금지: 순 수량
      }
      return +net.toFixed(8);
    };

    const usdM_ETHnetQty = await getUsdmEthNetQty();

    // 합계
    const walletsTotalETH = +(
      spotETH + fundingETH + marginCrossETH + marginIsoETH + earnETH
    ).toFixed(8);

    return res.status(200).json({
      account: useAcct2 ? "acct2" : "acct1",
      spot: {
        spotETH: +spotETH.toFixed(8),
        fundingETH: +fundingETH.toFixed(8),
        marginCrossETH: +marginCrossETH.toFixed(8),
        marginIsoETH: +marginIsoETH.toFixed(8),
        earnETH: +earnETH.toFixed(8),
        walletsTotalETH,
      },
      futures: { usdM_ETHnetQty }, // ✅ 순 수량(net)
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}