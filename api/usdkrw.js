// api/usdkrw.js — Vercel Edge Function
export const config = { runtime: 'edge' };

async function fetchJson(url, { headers = {}, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const UA = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Vercel Edge)' };

export default async function handler(req) {
  const urlObj = new URL(req.url);
  const prefer = urlObj.searchParams.get('prefer'); // 'dunamu' 강제 옵션
  const tries = [];

  const steps = prefer === 'dunamu'
    ? ['dunamu', 'yahoo', 'host']
    : ['yahoo', 'dunamu', 'host'];

  for (const src of steps) {
    try {
      if (src === 'yahoo') {
        const r = await fetchJson(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=USDKRW=X&_t=${Date.now()}`,
          { headers: UA, timeoutMs: 2000 }
        );
        tries.push({ source: 'yahoo', status: r.status, ok: r.ok, error: r.error });
        const rate = Number(r?.json?.quoteResponse?.result?.[0]?.regularMarketPrice);
        if (r.ok && Number.isFinite(rate) && rate > 0) {
          return json200({ rate, source: 'yahoo' });
        }
      }

      if (src === 'dunamu') {
        const r = await fetchJson(
          'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD',
          { headers: UA, timeoutMs: 2000 }
        );
        tries.push({ source: 'dunamu', status: r.status, ok: r.ok, error: r.error });
        if (r.ok && Array.isArray(r.json) && r.json[0] && Number(r.json[0].basePrice) > 0) {
          const rate = Number(r.json[0].basePrice);
          return json200({ rate, source: 'dunamu' });
        }
      }

      if (src === 'host') {
        const r = await fetchJson(
          'https://api.exchangerate.host/latest?base=USD&symbols=KRW',
          { headers: UA, timeoutMs: 2000 }
        );
        tries.push({ source: 'host', status: r.status, ok: r.ok, error: r.error });
        const rate = Number(r?.json?.rates?.KRW);
        if (r.ok && Number.isFinite(rate) && rate > 0) {
          return json200({ rate, source: 'host' });
        }
      }
    } catch (e) {
      tries.push({ source: src, ok: false, status: 0, error: String(e) });
    }
  }

  return new Response(JSON.stringify({
    error: 'All sources failed',
    tries: tries.map(x => ({ source: x.source, status: x.status, ok: x.ok, error: x.error })),
    t: Date.now()
  }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}

function json200(obj) {
  return new Response(JSON.stringify({ ...obj, t: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}