// api/binance-btc-summary.js
import crypto from "crypto";

/**
 * 정확한 "BTC 개수" 집계:
 * - spotBTC: SPOT 지갑의 실제 BTC 수량 (free + locked)
 * - fundingBTC: Funding 지갑의 실제 BTC 수량
 * - marginCrossBTC: Cross Margin의 BTC 순자산(netAsset)
 * - marginIsoBTC: (현재 0, 필요 시 isolated 계정 전량 스캔 로직 추가)
 *
 * 선물:
 * - usdM_BTCpos: USDⓈ-M 포지션의 BTC 수량 합(절대값). PM이면 PAPI, 아니면 FAPI.
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

    const now = Date.now();
    const recv = 60000;

    // ---- 공용 호출자: GET(query) / POST(body) 둘 다 지원 ----
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

    // ---- 1) SPOT BTC (정확한 수량) ----
    // POST /sapi/v3/asset/getUserAsset  (asset=BTC)
    const spotR = await callPOST("https://api.binance.com", "/sapi/v3/asset/getUserAsset", { asset: "BTC" });
    let spotBTC = 0;
    if (Array.isArray(spotR.json)) {
      const row = spotR.json.find((x) => String(x.asset) === "BTC");
      if (row) {
        const free = Number(row.free ?? 0);
        const locked = Number(row.locked ?? 0);
        spotBTC = free + locked;
      }
    }

    // ---- 2) Funding BTC (정확한 수량) ----
    // POST /sapi/v1/asset/getFundingAsset (asset=BTC)
    const fundingR = await callPOST("https://api.binance.com", "/sapi/v1/asset/getFundingAsset", { asset: "BTC" });
    let fundingBTC = 0;
    if (Array.isArray(fundingR.json)) {
      for (const it of fundingR.json) {
        if (String(it.asset) === "BTC") {
          // 필드가 케이스마다 balance/free/locked로 다를 수 있어 안전 합산
          const candidates = [it.balance, it.free, it.locked, it.freeze];
          for (const v of candidates) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) fundingBTC += n;
          }
        }
      }
    }

    // ---- 3) Cross Margin BTC (netAsset) ----
    // GET /sapi/v1/margin/account
    const crossR = await callGET("https://api.binance.com", "/sapi/v1/margin/account");
    let marginCrossBTC = 0;
    if (crossR.json && Array.isArray(crossR.json.userAssets)) {
      const row = crossR.json.userAssets.find((x) => String(x.asset) === "BTC");
      if (row) {
        const net = Number(row.netAsset ?? 0);
        if (Number.isFinite(net)) marginCrossBTC = net;
      }
    }

    // ---- 4) Isolated Margin BTC (지금은 0으로; 필요 시 확장) ----
    let marginIsoBTC = 0;
    // 향후 필요 시:
    // const isoR = await callGET("https://api.binance.com", "/sapi/v1/margin/isolated/account", { symbols: "all" });
    // ... assets[].baseAsset/quoteAsset 중 asset==="BTC" 의 netAsset 합산

    // ---- 5) USDⓈ-M BTC 포지션 (PM→PAPI, 아니면 FAPI 폴백) ----
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
        const amt = Number(p.positionAmt);
        if (Number.isFinite(amt) && amt !== 0) sum += Math.abs(amt);
      }
      return +sum.toFixed(8);
    };

    const usdM_BTCpos = await getUsdmBtcPos();

    return res.status(200).json({
      spot: {
        spotBTC: +spotBTC.toFixed(8),             // SPOT(정확한 BTC 개수)
        fundingBTC: +fundingBTC.toFixed(8),       // Funding(정확한 BTC 개수)
        marginCrossBTC: +marginCrossBTC.toFixed(8), // Cross Margin 순자산(± 가능)
        marginIsoBTC: +marginIsoBTC.toFixed(8),   // 현재 0 (확장 가능)
        walletsTotalBTC: +(
          spotBTC + fundingBTC + marginCrossBTC + marginIsoBTC
        ).toFixed(8),
      },
      futures: { usdM_BTCpos },
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}