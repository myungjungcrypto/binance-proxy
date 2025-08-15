// api/wallet-balances.js
import crypto from "crypto"; // (안써도 되지만 Vercel 빌드 환경상 기본 import 유지)

const COVALENT_KEY = process.env.COVALENT_API_KEY;

// 지원 체인 맵 (필요시 추가)
const CHAINS = {
  eth: 1,            // Ethereum Mainnet
  bsc: 56,           // BNB Chain
  polygon: 137,      // Polygon
  arbitrum: 42161,   // Arbitrum One
  optimism: 10,      // Optimism
  avalanche: 43114,  // Avalanche C-Chain
  base: 8453,        // Base
  // solana: ???  // ← Foundational 잔고는 501 나오는 경우 많음 (Streaming/Helius 권장)
};

function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

export default async function handler(req, res) {
  try {
    if (!COVALENT_KEY) {
      return res.status(500).json({ error: "Missing COVALENT_API_KEY env" });
    }

    const chainQ = String(req.query?.chain || "eth").toLowerCase();
    const address = String(req.query?.address || "").trim();
    const minUSD = toNum(req.query?.minUSD) || 10;  // 토큰 상세 나열 최소 USD 기준

    if (!address) {
      return res.status(400).json({ error: "Missing 'address' query param" });
    }

    // Solana는 Foundational 잔고가 미지원/제한 → 501로 명확히 응답
    if (chainQ.startsWith("sol")) {
      return res.status(501).json({
        error: "Solana balances not supported by Foundational REST (use Helius or Streaming API)",
      });
    }

    const chainId = CHAINS[chainQ];
    if (!chainId) {
      return res.status(400).json({ error: `Unsupported chain '${chainQ}'. Use one of: ${Object.keys(CHAINS).join(", ")}` });
    }

    // Covalent v1 balances_v2
    // docs 스타일: /v1/{chain_id}/address/{address}/balances_v2/?quote-currency=USD&nft=false&no-nft-fetch=true
    const url = `https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/` +
                `?quote-currency=USD&nft=false&no-nft-fetch=true`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${COVALENT_KEY}` },
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    if (!r.ok || !json?.data?.items) {
      return res.status(r.status || 502).json({
        error: "Covalent API failed",
        status: r.status,
        sample: text?.slice(0, 300),
      });
    }

    const items = json.data.items; // 토큰별
    let totalUSD = 0;
    const tokens = [];

    for (const it of items) {
      // it.balance 는 정수 문자열(wei 등), it.contract_decimals 로 스케일
      const decimals = toNum(it.contract_decimals);
      const raw = it.balance; // string
      const bal = raw ? Number(raw) / Math.pow(10, decimals || 0) : 0;

      // USD 환산: quote_rate(USD) * balance
      const quote = toNum(it.quote_rate);
      const usd = bal * quote;

      totalUSD += (Number.isFinite(usd) ? usd : 0);

      // 보기 좋게 상위 토큰만 담기
      if (usd >= minUSD) {
        tokens.push({
          chain: chainQ,
          contract_address: it.contract_address,
          symbol: it.contract_ticker_symbol,
          name: it.contract_name,
          decimals,
          balance: Number(bal.toFixed(8)),
          price: quote ? Number(quote.toFixed(6)) : null,
          usd: Number(usd.toFixed(2)),
          is_native: !!it.native_token, // 네이티브(ETH, MATIC 등)
        });
      }
    }

    // 내림차순 정렬, 최대 50개만
    tokens.sort((a, b) => b.usd - a.usd);
    const topTokens = tokens.slice(0, 50);

    return res.status(200).json({
      chain: chainQ,
      address,
      totalUSD: Number(totalUSD.toFixed(2)),
      topTokens,
      minUSD,
      t: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}