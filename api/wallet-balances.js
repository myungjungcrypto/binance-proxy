// api/wallet-balance.js
export default async function handler(req, res) {
  try {
    const { addr } = req.query;
    const apiKey = process.env.COVALENT_API_KEY;

    if (!addr) {
      return res.status(400).json({ error: "Missing address" });
    }

    // 여기선 체인을 ETH 메인넷으로 고정
    const chainId = "eth-mainnet";

    const url = `https://api.covalenthq.com/v1/${chainId}/address/${addr}/balances_v2/?quote-currency=USD&nft=false&no-nft-fetch=true&key=${apiKey}`;

    const r = await fetch(url);
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!r.ok) {
      return res.status(r.status).json({ error: "Covalent API failed", sample: text });
    }

    return res.status(200).json(json);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}