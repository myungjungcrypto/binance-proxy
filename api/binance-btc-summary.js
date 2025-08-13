// api/binance-btc-summary.js
// 목적: Binance의 모든 지갑에서 보유한 BTC 수량(현물 총합) + BTC 선물 포지션 수량(USDM 위주)을 한 번에 반환
// 주의: COIN-M(USD 기반 계약)은 별도 처리 필요. 기본은 USDT/TUSD 기반 USD-M의 BTC 포지션만 합산.
// 필요 ENV: BINANCE_API_KEY, BINANCE_SECRET_KEY

import crypto from "crypto";

function sign(query, secret) {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function fetchJson(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing API credentials" });
    }

    const ts = Date.now();
    const commonHeaders = { "X-MBX-APIKEY": apiKey };

    // 헬퍼: 서명 붙여 호출
    const callSigned = async (baseUrl, path, paramsObj = {}, timeoutMs = 6000) => {
      const params = new URLSearchParams({ ...paramsObj, timestamp: String(ts) });
      const sig = sign(params.toString(), secretKey);
      const url = `${baseUrl}${path}?${params.toString()}&signature=${sig}`;
      return await fetchJson(url, { headers: commonHeaders, timeoutMs });
    };

    // 1) SPOT(현물) BTC: /api/v3/account → balances[] 에서 BTC 찾기
    const spotP = callSigned(
      "https://api.binance.com",
      "/api/v3/account"
    );

    // 2) FUNDING(펀딩 지갑) BTC: /sapi/v1/asset/get-funding-asset?asset=BTC
    const fundingP = callSigned(
      "https://api.binance.com",
      "/sapi/v1/asset/get-funding-asset",
      { asset: "BTC" }
    );

    // 3) CROSS MARGIN BTC: /sapi/v1/margin/account → userAssets[] 내 BTC
    const crossMarginP = callSigned(
      "https://api.binance.com",
      "/sapi/v1/margin/account"
    );

    // 4) ISOLATED MARGIN BTC(선택): 심볼 전부는 무거워서 BTC 관련 대표 심볼만 시도
    // 필요시 배열에 BTC 관련 심볼 추가
    const isoSymbols = ["BTCUSDT", "BTCTUSD"];
    const isolatedPromises = isoSymbols.map(sym =>
      callSigned("https://api.binance.com", "/sapi/v1/margin/isolated/account", { symbols: sym })
    );

    // 5) USDⓈ-M Futures BTC 포지션: /fapi/v2/positionRisk → symbol startsWith('BTC') 합산
    const futuresUsdmP = callSigned(
      "https://fapi.binance.com",
      "/fapi/v2/positionRisk"
    );

    // (선택) 6) COIN-M Futures (BTCUSD 등) — 필요시 주석 해제
    // const futuresCoinmP = callSigned(
    //   "https://dapi.binance.com",
    //   "/dapi/v1/positionRisk"
    // );

    const [
      spotR, fundingR, crossMarginR, ...rest
    ] = await Promise.all([spotP, fundingP, crossMarginP, ...isolatedPromises, futuresUsdmP /*, futuresCoinmP*/]);

    const futuresUsdmR = rest[isolatedPromises.length]; // 마지막 요소가 USDM 결과
    // const futuresCoinmR = rest[isolatedPromises.length + 1];

    // ---- 파싱 ----
    // SPOT
    let spotBTC = 0;
    if (spotR.ok && spotR.json?.balances) {
      const btc = spotR.json.balances.find(b => b.asset === "BTC");
      if (btc) spotBTC = num(btc.free) + num(btc.locked);
    }

    // FUNDING
    let fundingBTC = 0;
    if (fundingR.ok && Array.isArray(fundingR.json)) {
      // [{ asset:"BTC", free:"", locked:"", freeze:"" ... }]
      for (const it of fundingR.json) {
        if (it.asset === "BTC") {
          fundingBTC += num(it.free) + num(it.locked) + num(it.freeze);
        }
      }
    }

    // CROSS MARGIN
    let marginCrossBTC = 0;
    if (crossMarginR.ok && crossMarginR.json?.userAssets) {
      const btc = crossMarginR.json.userAssets.find(a => a.asset === "BTC");
      if (btc) {
        // 순 BTC = free + locked - borrowed + interest? (단순 보유량만 합산: free + locked)
        marginCrossBTC = num(btc.free) + num(btc.locked);
      }
    }

    // ISOLATED MARGIN (BTC 관련 심볼만)
    let marginIsoBTC = 0;
    for (let i = 0; i < isolatedPromises.length; i++) {
      const r = rest[i];
      if (r?.ok && r.json?.assets) {
        // assets: [{baseAsset:{asset:'BTC', free, locked}, quoteAsset:{...}}]
        for (const a of r.json.assets) {
          if (a?.baseAsset?.asset === "BTC") {
            marginIsoBTC += num(a.baseAsset.free) + num(a.baseAsset.locked);
          }
          // 혹시 quote 에 BTC가 들어갈 일은 거의 없지만 안전 차단
          if (a?.quoteAsset?.asset === "BTC") {
            marginIsoBTC += num(a.quoteAsset.free) + num(a.quoteAsset.locked);
          }
        }
      }
    }

    // 현물/마진 총합
    const spotTotalBTC = spotBTC + fundingBTC + marginCrossBTC + marginIsoBTC;

    // USDⓈ-M Futures BTC 포지션
    // positionRisk[]: symbol, positionAmt, markPrice ...
    // BTCUSDT, BTCTUSD 등 BTC로 시작하는 심볼만 합산 (절대값 기준; 필요에 따라 순수량으로 바꾸려면 abs 제거)
    let futuresBtcUsdm = 0;
    if (futuresUsdmR?.ok && Array.isArray(futuresUsdmR.json)) {
      for (const p of futuresUsdmR.json) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("BTC")) continue;
        const qty = num(p.positionAmt); // USDM은 base 수량 단위(=BTC)
        if (qty !== 0) futuresBtcUsdm += Math.abs(qty);
      }
    } else if (futuresUsdmR?.json && futuresUsdmR?.json?.code) {
      // 에러 케이스 전달
      // nothing
    }

    // (선택) COIN-M — 계약수/명목 등의 차이가 있어 정확 합산이 까다로워 기본 제외
    // let futuresBtcCoinm = 0;
    // if (futuresCoinmR?.ok && Array.isArray(futuresCoinmR.json)) {
    //   for (const p of futuresCoinmR.json) {
    //     const sym = String(p.symbol || "");
    //     if (!sym.startsWith("BTC")) continue;
    //     const qty = num(p.positionAmt); // Coin-M 명세에 따라 해석 주의 (여기선 단순 합)
    //     if (qty !== 0) futuresBtcCoinm += Math.abs(qty);
    //   }
    // }

    return res.status(200).json({
      spot: {
        spotBTC: +spotBTC.toFixed(8),
        fundingBTC: +fundingBTC.toFixed(8),
        marginCrossBTC: +marginCrossBTC.toFixed(8),
        marginIsoBTC: +marginIsoBTC.toFixed(8),
        spotTotalBTC: +spotTotalBTC.toFixed(8)
      },
      futures: {
        usdM_BTCpos: +futuresBtcUsdm.toFixed(8)
        // , coinM_BTCpos: +futuresBtcCoinm.toFixed(8)
      },
      notes: "COIN-M 선물은 기본 제외(주석). 필요시 주석 해제 및 계약단위 확인 후 사용.",
      t: Date.now()
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}