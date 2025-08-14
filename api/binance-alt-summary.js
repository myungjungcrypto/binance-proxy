// api/binance-alt-summary.js
import crypto from "crypto";

// ----- 설정 -----
const EXCLUDED = new Set(["BTC", "ETH"]);   // 알트 정의: BTC/ETH 제외
const MIN_USD = 100;                         // $100 이상만 집계

// 공용: 서명/요청
function signQS(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}
async function signedFetch(base, path, apiKey, secretKey, params = {}) {
  const query = new URLSearchParams({ timestamp: Date.now(), ...params }).toString();
  const sig = signQS(secretKey, query);
  const url = `${base}${path}?${query}&signature=${sig}`;
  const r = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  const txt = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(txt), raw: txt };
  } catch {
    return { ok: false, status: r.status, json: null, raw: txt };
  }
}
async function publicJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return null; }
}

// BTCUSDT 가격 (지갑 BTC평가→USD 전환에 필요)
async function getBtcUsdt() {
  // 다중 백업: 바이낸스 → 바이비트 → 코인베이스
  // (Vercel 싱가포르 리전이면 바이낸스 접근 잘 됩니다)
  try {
    const j = await publicJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    const p = Number(j?.price);
    if (p > 0) return p;
  } catch {}
  try {
    const j = await publicJson("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT");
    const p = Number(j?.result?.list?.[0]?.lastPrice);
    if (p > 0) return p;
  } catch {}
  try {
    const j = await publicJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
    const p = Number(j?.price ?? j?.last);
    if (p > 0) return p;
  } catch {}
  return 0;
}

// 지갑(현물/마진/펀딩 등) 알트 총액 USD 계산
async function getAltWalletUSD(apiKey, secretKey) {
  // /sapi/v3/asset/getUserAsset?needBtcValuation=true 로 코인별 보유 & BTC평가액 제공
  const { ok, json, raw } = await signedFetch(
    "https://api.binance.com",
    "/sapi/v3/asset/getUserAsset",
    apiKey,
    secretKey,
    { needBtcValuation: true }
  );
  if (!ok || !Array.isArray(json)) {
    return { totalUSD: 0, items: [], debug: raw ?? json };
  }

  const btcUsdt = await getBtcUsdt();
  if (!btcUsdt) return { totalUSD: 0, items: [], debug: "No BTCUSDT price" };

  let totalUSD = 0;
  const items = [];

  for (const a of json) {
    const asset = a.asset?.toUpperCase?.() || "";
    if (!asset || EXCLUDED.has(asset)) continue;

    // 총 수량 (free + locked)
    const qty =
      (Number(a.free) || 0) +
      (Number(a.locked) || 0) +
      (Number(a.freeze) || 0) +
      (Number(a.withdrawing) || 0);

    // Binance가 제공하는 btcValuation 사용 → USD 변환
    const btcVal = Number(a.btcValuation) || 0;
    const usd = btcVal * btcUsdt;

    if (qty > 0 && usd >= MIN_USD) {
      items.push({ asset, qty, usd: Number(usd.toFixed(2)) });
      totalUSD += usd;
    }
  }

  // 큰 금액 우선 나열
  items.sort((x, y) => y.usd - x.usd);
  return { totalUSD: Number(totalUSD.toFixed(2)), items };
}

// USD‑M 선물 알트 포지션 총액 USD 계산 (노출 금액 기준: |수량| * markPrice)
async function getAltFuturesUSD(apiKey, secretKey) {
  const { ok, json, raw } = await signedFetch(
    "https://fapi.binance.com",
    "/fapi/v2/positionRisk",
    apiKey,
    secretKey
  );
  if (!ok || !Array.isArray(json)) {
    return { totalUSD: 0, items: [], debug: raw ?? json };
  }

  let totalUSD = 0;
  const itemsMap = new Map(); // 심볼별 합산

  for (const p of json) {
    const amt = Number(p.positionAmt) || 0;
    if (amt === 0) continue;

    const symbol = String(p.symbol || "");
    // 심볼에서 코인 티커 추출 (예: ARBUSDT → ARB, DOGEUSDT → DOGE)
    let base = symbol.endsWith("USDT") ? symbol.replace("USDT", "") : symbol;
    base = base.toUpperCase();

    if (EXCLUDED.has(base)) continue;

    const usd = Math.abs(amt * (Number(p.markPrice) || 0));
    if (usd >= MIN_USD) {
      const prev = itemsMap.get(base) || 0;
      itemsMap.set(base, prev + usd);
    }
  }

  const items = Array.from(itemsMap.entries())
    .map(([asset, usd]) => ({ asset, usd: Number(usd.toFixed(2)) }))
    .sort((a, b) => b.usd - a.usd);

  const totalUSD = items.reduce((s, it) => s + it.usd, 0);
  return { totalUSD: Number(totalUSD.toFixed(2)), items };
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Binance API credentials" });
    }

    // 동시 실행
    const [wallet, futures] = await Promise.all([
      getAltWalletUSD(apiKey, secretKey),
      getAltFuturesUSD(apiKey, secretKey),
    ]);

    return res.status(200).json({
      altWalletUSD: wallet.totalUSD,
      altWalletTop: wallet.items.slice(0, 20), // 상위 20개만 노출
      altFuturesUSD: futures.totalUSD,
      altFuturesTop: futures.items.slice(0, 20),
      minUSD: MIN_USD,
      excluded: Array.from(EXCLUDED),
      t: Date.now(),
      // 필요 시 내부 디버그 확인:
      // debug: { wallet: wallet.debug, futures: futures.debug }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}