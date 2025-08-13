// api/usdkrw.js
// 의존성 없음. @vercel/node (Node.js) 서버리스 함수.

// 공용: 타임아웃 있는 fetch JSON
async function fetchJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
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
  
  export default async function handler(req, res) {
    const ua = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Vercel Proxy)' };
    const tries = [];
  
    // 1) Dunamu (가장 실시간) — 지역/네트워크에 따라 막힐 수 있음
    {
      const url = 'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD';
      const r = await fetchJson(url, { headers: ua, timeoutMs: 2500 });
      tries.push({ source: 'dunamu', ...r });
      if (r.ok && r.json && Array.isArray(r.json) && r.json[0] && Number(r.json[0].basePrice) > 0) {
        const rate = Number(r.json[0].basePrice);
        return res.status(200).json({ rate, source: 'dunamu', t: Date.now() });
      }
    }
  
    // 2) Yahoo Finance
    {
      const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=USDKRW=X';
      const r = await fetchJson(url, { headers: ua, timeoutMs: 2500 });
      tries.push({ source: 'yahoo', ...r });
      const rate = Number(r?.json?.quoteResponse?.result?.[0]?.regularMarketPrice);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'yahoo', t: Date.now() });
      }
    }
  
    // 3) exchangerate.host
    {
      const url = 'https://api.exchangerate.host/latest?base=USD&symbols=KRW';
      const r = await fetchJson(url, { headers: ua, timeoutMs: 2500 });
      tries.push({ source: 'host', ...r });
      const rate = Number(r?.json?.rates?.KRW);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'host', t: Date.now() });
      }
    }
  
    // 4) Frankfurter
    {
      const url = 'https://api.frankfurter.app/latest?from=USD&to=KRW';
      const r = await fetchJson(url, { headers: ua, timeoutMs: 2500 });
      tries.push({ source: 'frankfurter', ...r });
      const rate = Number(r?.json?.rates?.KRW);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'frankfurter', t: Date.now() });
      }
    }
  
    // 5) open.er-api
    {
      const url = 'https://open.er-api.com/v6/latest/USD';
      const r = await fetchJson(url, { headers: ua, timeoutMs: 2500 });
      tries.push({ source: 'erapi', ...r });
      const rate = Number(r?.json?.rates?.KRW);
      if (r.ok && Number.isFinite(rate) && rate > 0) {
        return res.status(200).json({ rate, source: 'erapi', t: Date.now() });
      }
    }
  
    // 전부 실패 — 디버그 로그 반환
    // (보안을 위해 원문 텍스트는 앞부분만 반환)
    const debug = tries.map(tr => ({
      source: tr.source,
      ok: tr.ok,
      status: tr.status,
      error: tr.error || undefined,
      sample: tr.text ? String(tr.text).slice(0, 140) : undefined
    }));
    return res.status(502).json({ error: 'All sources failed', tries: debug, t: Date.now() });
  }