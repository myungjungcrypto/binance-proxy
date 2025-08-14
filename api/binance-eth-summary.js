// api/binance-eth-summary.js
import crypto from "crypto";

/**
 * 정확한 "ETH 개수" 집계:
 * - spotETH: SPOT 지갑의 실제 ETH 수량 (free + locked)
 * - fundingETH: Funding 지갑의 실제 ETH 수량
 * - marginCrossETH: Cross Margin의 ETH 순자산(netAsset)
 * - marginIsoETH: (현재 0, 필요 시 isolated 계정 전량 스캔 로직 추가)
 *
 * 선물:
 * - usdM_ETHpos: USDⓈ-M 포지션의 ETH 수량 합(절대값). PM이면 PAPI, 아니면 FAPI.
 *
 * ENV (Vercel):
 * - BINANCE_API_KEY
 * - BINANCE_SECRET_KEY
 */

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }

    const sign = (q) => crypto.createHmac("sha256", secretKey).update(q).digest("hex");
    const headers = { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" };
    const recv = 60000;

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

    // ---- 1) SPOT ETH ----
    const spotR = await callPOST("https://api.binance.com", "/sapi/v3/asset/getUserAsset", { asset: "ETH" });
    let spotETH = 0;
    if (Array.isArray(spotR.json)) {
      const row = spotR.json.find((x) => String(x.asset) === "ETH");
      if (row) {
        const free = Number(row.free ?? 0);
        const locked = Number(row.locked ?? 0);
        spotETH = free + locked;
      }
    }

    // ---- 2) Funding ETH ----
    const fundingR = await callPOST("https://api.binance.com", "/sapi/v1/asset/getFundingAsset", { asset: "ETH" });
    let fundingETH = 0;
    if (Array.isArray(fundingR.json)) {
      for (const it of fundingR.json) {
        if (String(it.asset) === "ETH") {
          const candidates = [it.balance, it.free, it.locked, it.freeze];
          for (const v of candidates) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) fundingETH += n;
          }
        }
      }
    }

    // ---- 3) Cross Margin ETH (netAsset) ----
    const crossR = await callGET("https://api.binance.com", "/sapi/v1/margin/account");
    let marginCrossETH = 0;
    if (crossR.json && Array.isArray(crossR.json.userAssets)) {
      const row = crossR.json.userAssets.find((x) => String(x.asset) === "ETH");
      if (row) {
        const net = Number(row.netAsset ?? 0);
        if (Number.isFinite(net)) marginCrossETH = net;
      }
    }

    // ---- 4) Isolated Margin ETH (지금은 0; 필요시 확장) ----
    let marginIsoETH = 0;

    // ---- 5) USDⓈ-M ETH 포지션 (PM→PAPI, 아니면 FAPI 폴백) ----
    const getUsdmEthPos = async () => {
      const papi = await callGET("https://papi.binance.com", "/papi/v1/um/positionRisk");
      let list = Array.isArray(papi.json) && papi.ok ? papi.json : null;
      if (!list) {
        const fapi = await callGET("https://fapi.binance.com", "/fapi/v2/positionRisk");
        list = Array.isArray(fapi.json) && fapi.ok ? fapi.json : [];
      }
      let sum = 0;
      for (const p of list) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("ETH")) continue; // ETHUSDT, ETHUSDC 등
        const amt = Number(p.positionAmt);
        if (Number.isFinite(amt) && amt !== 0) sum += Math.abs(amt);
      }
      return +sum.toFixed(8);
    };

    const usdM_ETHpos = await getUsdmEthPos();

    return res.status(200).json({
      spot: {
        spotETH: +spotETH.toFixed(8),
        fundingETH: +fundingETH.toFixed(8),
        marginCrossETH: +marginCrossETH.toFixed(8),
        marginIsoETH: +marginIsoETH.toFixed(8),
        walletsTotalETH: +(
          spotETH + fundingETH + marginCrossETH + marginIsoETH
        ).toFixed(8),
      },
      futures: { usdM_ETHpos },
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}