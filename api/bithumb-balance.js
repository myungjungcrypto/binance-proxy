import crypto from "crypto";

const ENC = (o) => new URLSearchParams(o).toString();

async function tryCall({ apiKey, secretKey, endpoint, bodyStr, order, enc }) {
  const url = `https://api.bithumb.com${endpoint}`;
  const nonce = Date.now().toString();

  const parts = {
    ENDPARAMS: bodyStr,       // body
    ENDPOINT: endpoint,       // /info/balance
    NONCE: nonce
  };

  // 서명 순서 조합
  const sequences = {
    A: ["ENDPOINT", "ENDPARAMS", "NONCE"],         // (기본) endpoint \0 params \0 nonce
    B: ["ENDPOINT", "NONCE", "ENDPARAMS"],         // endpoint \0 nonce \0 params
    C: ["NONCE", "ENDPOINT", "ENDPARAMS"],         // nonce \0 endpoint \0 params
  };

  // 구분자 (NULL vs 세미콜론)
  const sep = enc === "semicolon" ? ";" : "\0";
  const toSign = sequences[order].map(k => parts[k]).join(sep);

  // 인코딩(base64/hex) 2가지
  const digestEnc = enc === "hex" ? "hex" : "base64";
  const signature = crypto.createHmac("sha512", secretKey).update(toSign).digest(digestEnc);

  const headers = {
    "Api-Key": apiKey,
    "Api-Sign": signature,
    "Api-Nonce": nonce,
    "Api-Client-Type": "2",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept": "application/json",
  };

  const resp = await fetch(url, { method: "POST", headers, body: bodyStr });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch {
    return { ok:false, order, enc, error:"Non-JSON", raw:text, sent:{ bodyStr, toSign, digestEnc } };
  }
  if (json.status === "0000") {
    const krw = parseFloat(json?.data?.total_krw || "0");
    return { ok:true, order, enc, totalKRW: krw, raw: json, sent:{ bodyStr, toSign, digestEnc } };
  }
  return { ok:false, order, enc, error:"API", data: json, sent:{ bodyStr, toSign, digestEnc } };
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const secretKey = process.env.BITHUMB_SECRET_KEY;
    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/balance";

    // (1) endpoint를 인코딩하지 않은 원문으로 body 구성 (권장)
    const bodyRaw = `endpoint=${endpoint}&currency=ALL`;
    // (2) endpoint를 URL 인코딩한 방식도 준비 (일부 환경)
    const bodyEnc = ENC({ endpoint, currency: "ALL" }); // 자동 인코딩됨

    const tries = [];
    // 순서 A/B/C × 인코딩(base64/hex/semicolon) × body(raw/enc)
    const orders = ["A","B","C"];
    const encs = ["base64","hex","semicolon"];

    for (const bodyStr of [bodyRaw, bodyEnc]) {
      for (const order of orders) {
        for (const enc of encs) {
          // eslint-disable-next-line no-await-in-loop
          const r = await tryCall({ apiKey, secretKey, endpoint, bodyStr, order, enc });
          tries.push(r);
          if (r.ok) {
            return res.status(200).json({
              totalKRW: r.totalKRW,
              mode: { body: bodyStr === bodyRaw ? "raw" : "encoded", order, enc },
              raw: r.raw,
              debug: r.sent
            });
          }
        }
      }
    }

    return res.status(500).json({ error: "All strategies failed", tries });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}