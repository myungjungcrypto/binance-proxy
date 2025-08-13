import crypto from "crypto";

function sign(ts, method, path, query, body, secret) {
  const qs = query ? `?${query}` : "";
  const prehash = `${ts}${method.toUpperCase()}${path}${qs}${body || ""}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITGET_API_KEY;
    const apiSecret = process.env.BITGET_SECRET_KEY;
    const passphrase = process.env.BITGET_API_PASSPHRASE;
    if (!apiKey || !apiSecret || !passphrase) {
      return res.status(500).json({ error: "Missing Bitget API credentials" });
    }

    const ts = Date.now().toString();
    const method = "GET";
    const path = "/api/v2/account/all-account-balance";
    const sig = sign(ts, method, path, "", "", apiSecret);

    const r = await fetch(`https://api.bitget.com${path}`, {
      method,
      headers: {
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": sig,
        "ACCESS-TIMESTAMP": ts,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
        "locale": "en-US"
      }
    });

    const data = await r.json();
    if (data.code !== "00000") {
      return res.status(500).json({ error: "Bitget API Error", data });
    }

    const list = Array.isArray(data.data) ? data.data : [];
    let total = 0;
    const breakdown = [];
    for (const it of list) {
      const v = parseFloat(it.usdtBalance || "0");
      if (!Number.isNaN(v)) {
        total += v;
        breakdown.push({ accountType: it.accountType, usdt: v });
      }
    }

    return res.status(200).json({
      totalUSD: Math.round(total * 100) / 100,
      breakdown
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}