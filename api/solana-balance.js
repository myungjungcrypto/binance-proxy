// /api/solana-balance.js
import { setTimeout as delay } from "timers/promises";

const COVALENT_BASE = "https://api.covalenthq.com/v1";
const CHAIN = "solana-mainnet-beta"; // Solana 메인넷

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.COVALENT_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: "Missing COVALENT_API_KEY" });

    const addr = String(req.query?.addr || "").trim();
    if (!addr) return res.status(400).json({ error: "addr (Solana address) required" });

    // 옵션: $100 이상만 포함 (기본 10)
    const minUSD = toNum(req.query?.minUSD, 10);

    // Covalent Foundational: wallet balances (with prices)
    // GET /v1/{chain}/address/{address}/balances_v2/
    const url = `${COVALENT_BASE}/${CHAIN}/address/${addr}/balances_v2/?key=${API_KEY}&quote-currency=USD&nft=false&no-spam=true`;
    // 잠시 rate-limit 회피의 소프트 백오프 (최대 2회 재시도)
    let r = await fetchJson(url);
    if (!r.ok && r.status === 429) { await delay(500); r = await fetchJson(url); }
    if (!r.ok && r.status === 429) { await delay(1000); r = await fetchJson(url); }

    if (!r.ok || !r.json?.data) {
      return res.status(502).json({ error: "Covalent API failed", status: r.status, sample: r.text?.slice(0,140) });
    }

    const items = Array.isArray(r.json.data.items) ? r.json.data.items : [];
    const top = [];
    let totalUSD = 0;

    for (const it of items) {
      const symbol = String(it.contract_ticker_symbol || "").toUpperCase();
      const name   = it.contract_name || symbol || "-";
      const dec    = toNum(it.contract_decimals, 0);
      // balance(정수) → 실제 수량
      const rawBal = it.balance ?? it.formatted_balance /* 일부 체인은 formatted_balance 제공 */;
      let qty = 0;
      if (rawBal != null) {
        if (typeof rawBal === "string" && dec >= 0) {
          // 원시 balance가 문자열(정수)인 케이스
          qty = Number(rawBal) / Math.pow(10, dec || 0);
        } else {
          // 이미 formatted_balance 가 들어오는 케이스
          qty = Number(rawBal);
        }
      }

      // Covalent가 붙여주는 현재가(USD)와 평가금액(USD)
      const quoteRate = toNum(it.quote_rate, 0);  // 1 토큰당 USD
      const usd       = toNum(it.quote, qty * quoteRate); // 총 USD

      if (usd >= minUSD && usd > 0) {
        totalUSD += usd;
        top.push({
          symbol,
          name,
          qty: Number(qty.toFixed(8)),
          priceUSD: Number(quoteRate.toFixed(6)),
          usd: Number(usd.toFixed(2)),
        });
      }
    }

    // 큰 순서 정렬, 상위 25개
    top.sort((a, b) => b.usd - a.usd);
    const top25 = top.slice(0, 25);

    return res.status(200).json({
      chain: CHAIN,
      address: addr,
      minUSD,
      totalUSD: Number(totalUSD.toFixed(2)),
      top: top25,
      countAll: items.length,
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}