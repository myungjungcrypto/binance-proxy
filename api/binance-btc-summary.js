// api/binance-btc-summary.js
import crypto from "crypto";

/**
 * 목적
 * 1) 현물/마진 지갑 등 "보유 BTC 수량" 합계 (지갑별 상세 + 합계)
 * 2) USDⓈ-M 선물의 BTC 포지션 수량 합계 (PM 계정이면 PAPI에서, 일반은 FAPI에서)
 *    - 필요 시 COIN-M도 포함 가능 (?includeCoinM=true)
 *
 * 필요 환경변수 (Vercel Dashboard > Settings > Environment Variables)
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

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const debug = urlObj.searchParams.get("debug") === "1";
    const includeCoinM = urlObj.searchParams.get("includeCoinM") === "true";

    // ---------- 공용: 서명 호출 ----------
    const signQuery = (q) =>
      crypto.createHmac("sha256", secretKey).update(q).digest("hex");

    const callSigned = async (base, path, extra = "") => {
      const timestamp = Date.now();
      const recvWindow = 60_000;
      const q = `recvWindow=${recvWindow}&timestamp=${timestamp}${
        extra ? `&${extra}` : ""
      }`;
      const sig = signQuery(q);
      const url = `${base}${path}?${q}&signature=${sig}`;
      const r = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // non-JSON 응답
      }
      return { ok: r.ok, status: r.status, json, text, url };
    };

    // ---------- 1) 지갑별 BTC 잔고 (BTC로 환산된 합계) ----------
    // 공식 문서: GET /sapi/v1/asset/wallet/balance?quoteAsset=BTC
    // (일부 권한 없이 동작하는 케이스 존재. 안되면 유니버설 트랜스퍼 권한 필요)
    const walletR = await callSigned(
      "https://api.binance.com",
      "/sapi/v1/asset/wallet/balance",
      "quoteAsset=BTC"
    );

    if (!walletR.ok || !Array.isArray(walletR.json)) {
      return res.status(502).json({
        error: "Wallet balance fetch failed",
        hint: "Check API key permission or try later",
        upstream: { status: walletR.status, body: walletR.text?.slice(0, 200) },
      });
    }

    // 지갑 이름들 예시:
    // Spot, Funding, Cross Margin, Isolated Margin, USDⓈ-M Futures, COIN-M Futures, Earn, Trading Bots, Copy Trading ...
    const pick = (name) =>
      Number(
        walletR.json.find((x) => String(x.walletName) === name)?.balance ?? 0
      );

    // Spot 그룹(현물로 간주할 지갑들): 선물/옵션/복사거래 등 명백히 파생상품 성격은 제외
    const SPOT_LIKE = new Set([
      "Spot",
      "Funding",
      "Cross Margin",
      "Cross Margin (PM)",
      "Isolated Margin",
      "Earn",
      "Trading Bots",
      "Copy Trading", // 필요 시 제외 가능
    ]);

    let spotBTC = 0;
    const perWallet = {};
    for (const w of walletR.json) {
      const name = String(w.walletName ?? "");
      const bal = Number(w.balance ?? 0);
      perWallet[name] = bal;
      if (SPOT_LIKE.has(name)) spotBTC += bal;
    }

    // 몇 개 대표 필드로도 제공
    const spotBreakdown = {
      spotBTC: perWallet["Spot"] ?? 0,
      fundingBTC: perWallet["Funding"] ?? 0,
      marginCrossBTC:
        (perWallet["Cross Margin (PM)"] ?? 0) + (perWallet["Cross Margin"] ?? 0),
      marginIsoBTC: perWallet["Isolated Margin"] ?? 0,
      // 참고용: 여기 포함하지 않는 파생지갑
      // usdmFuturesBTC: perWallet["USDⓈ-M Futures"] ?? 0,
      // coinmFuturesBTC: perWallet["COIN-M Futures"] ?? 0,
      spotTotalBTC: +spotBTC.toFixed(8),
    };

    // ---------- 2) USDⓈ-M BTC 포지션 (PM → 일반 폴백) ----------
    // PM/Unified 계정은 PAPI로, 일반은 FAPI로.
    // 응답 리스트에서 symbol이 'BTC'로 시작하는 항목의 positionAmt 절대값 합산.
    const getUsdmBtcPos = async () => {
      // PM 우선(papi)
      const papi = await callSigned(
        "https://papi.binance.com",
        "/papi/v1/um/positionRisk"
      );
      let list = Array.isArray(papi.json) && papi.ok ? papi.json : null;

      // 실패 시 일반(fapi)
      if (!list) {
        const fapi = await callSigned(
          "https://fapi.binance.com",
          "/fapi/v2/positionRisk"
        );
        list = Array.isArray(fapi.json) && fapi.ok ? fapi.json : [];
      }

      let sum = 0;
      for (const p of list) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("BTC")) continue; // BTCUSDT, BTCUSDC, BTCTUSD 등
        const qty = Number(p.positionAmt);
        if (Number.isFinite(qty) && qty !== 0) sum += Math.abs(qty);
      }
      return +sum.toFixed(8);
    };

    // ---------- (옵션) COIN-M BTC 포지션 ----------
    const getCoinmBtcPos = async () => {
      // PM 계정에서도 coin-M은 dapi 쪽 사용 (papi coin-m positionRisk가 별도이긴 하나 dapi가 보편)
      const dapi = await callSigned(
        "https://dapi.binance.com",
        "/dapi/v1/positionRisk"
      );
      if (!Array.isArray(dapi.json)) return 0;

      // COIN‑M은 계약 단위 주의 필요. BTCUSD 퍼페추얼의 quantity는 "계약수"이며,
      // 일반적으로 1 계약 = 100 USD 기준값인 경우가 있음.
      // 여기서는 간단히 BTC 기반 심볼만 골라서 (예: BTCUSD) notionalValue/markPrice 등으로 환산하려면 추가 로직 필요.
      // 일단 BTC 심볼만 골라 "코인 수량"과 유사한 값으로 추정하려면:
      // - 일부 응답에는 positionAmt가 코인수인 마켓도 있으므로 우선 절대값 합산(보수적).
      let sum = 0;
      for (const p of dapi.json) {
        const sym = String(p.symbol || "");
        if (!sym.startsWith("BTC")) continue; // BTCUSD, BTCUSD_PERP 등
        const qty = Number(p.positionAmt);
        if (Number.isFinite(qty) && qty !== 0) sum += Math.abs(qty);
      }
      return +sum.toFixed(8);
    };

    const [usdM_BTCpos, coinM_BTCpos] = await Promise.all([
      getUsdmBtcPos(),
      includeCoinM ? getCoinmBtcPos() : Promise.resolve(0),
    ]);

    const out = {
      spot: spotBreakdown,
      futures: {
        usdM_BTCpos,
        ...(includeCoinM ? { coinM_BTCpos } : {}),
      },
      t: Date.now(),
    };

    if (debug) {
      out._debugSample = {
        // 지갑 이름과 값 일부만 표시(많으면 잘라냄)
        wallets: Object.fromEntries(
          Object.entries(perWallet).slice(0, 12)
        ),
      };
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}