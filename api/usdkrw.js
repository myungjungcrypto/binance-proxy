// api/usdkrw.js
async function fetchJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { ok: r.ok, status: r.status, json, text };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    } finally { clearTimeout(t); }
  }
  
  const UA = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Vercel Proxy)' };
  
  export default async function handler(req, res) {
    const tries = [];
  
    // 1) Yahoo Finance (실시간 근접)
    {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=USDKRW=X&_t=${Date.now()}`;
      const r = await fetchJson(url, { headers: UA, timeoutMs: 2500 });
      tries.push({ source: 'yahoo', status: r.status, ok: r.ok, error: r.error });
      const rate = Number(r?.json?.quoteResponse?.result?.[0]?.regularMarketPrice);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'yahoo', t: Date.now() });
      }
    }
  
    // 2) Dunamu (가능하면 사용)
    {
      const url = 'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD';
      const r = await fetchJson(url, { headers: UA, timeoutMs: 2500 });
      tries.push({ source: 'dunamu', status: r.status, ok: r.ok, error: r.error });
      if (r.ok && Array.isArray(r.json) && r.json[0] && Number(r.json[0].basePrice) > 0) {
        const rate = Number(r.json[0].basePrice);
        return res.status(200).json({ rate, source: 'dunamu', t: Date.now() });
      }
    }
  
    // 3) exchangerate.host (백업)
    {
      const url = 'https://api.exchangerate.host/latest?base=USD&symbols=KRW';
      const r = await fetchJson(url, { headers: UA, timeoutMs: 2500 });
      tries.push({ source: 'host', status: r.status, ok: r.ok, error: r.error });
      const rate = Number(r?.json?.rates?.KRW);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'host', t: Date.now() });
      }
    }
  
    // 4) open.er-api (최후 백업)
    {
      const url = 'https://open.er-api.com/v6/latest/USD';
      const r = await fetchJson(url, { headers: UA, timeoutMs: 2500 });
      tries.push({ source: 'erapi', status: r.status, ok: r.ok, error: r.error });
      const rate = Number(r?.json?.rates?.KRW);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'erapi', t: Date.now() });
      }
    }
  
    return res.status(502).json({
      error: 'All sources failed',
      tries: tries.map(x => ({ source: x.source, status: x.status, ok: x.ok, error: x.error })),
      t: Date.now()
    });
  }