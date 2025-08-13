// api/usdkrw.js
export default async function handler(req, res) {
    try {
      // 1순위: 두나무 (가장 실시간/정확)
      try {
        const r = await fetch('https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD', {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Vercel Proxy)' },
        });
        if (r.ok) {
          const arr = await r.json();
          const rate = Number(arr?.[0]?.basePrice);
          if (Number.isFinite(rate) && rate > 0) {
            return res.status(200).json({ rate, source: 'dunamu', t: Date.now() });
          }
        }
      } catch (_) {}
  
      // 2순위: Yahoo Finance
      try {
        const r = await fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=USDKRW=X', {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Vercel Proxy)' },
        });
        if (r.ok) {
          const j = await r.json();
          const rate = Number(j?.quoteResponse?.result?.[0]?.regularMarketPrice);
          if (Number.isFinite(rate) && rate > 0) {
            return res.status(200).json({ rate, source: 'yahoo', t: Date.now() });
          }
        }
      } catch (_) {}
  
      // 3순위: exchangerate.host
      try {
        const r = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=KRW');
        if (r.ok) {
          const j = await r.json();
          const rate = Number(j?.rates?.KRW);
          if (Number.isFinite(rate) && rate > 0) {
            return res.status(200).json({ rate, source: 'host', t: Date.now() });
          }
        }
      } catch (_) {}
  
      // 전부 실패
      return res.status(502).json({ error: 'All sources failed' });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'server error' });
    }
  }