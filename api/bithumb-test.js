import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.BITHUMB_API_KEY;
    const secretKey = process.env.BITHUMB_SECRET_KEY;

    if (!apiKey || !secretKey) {
      return res.status(500).json({ error: "Missing Bithumb API credentials" });
    }

    const endpoint = "/info/account";
    const url = `https://api.bithumb.com${endpoint}`;
    const nonce = Date.now().toString();

    const params = ""; // /info/account 는 필수 파라미터 없음
    const strToSign = `${endpoint}\0${params}\0${nonce}`;

    const signature = crypto
      .createHmac("sha512", secretKey)
      .update(strToSign)
      .digest("base64");

    const headers = {
      "Api-Key": apiKey,
      "Api-Sign": signature,
      "Api-Nonce": nonce,
      "Api-Client-Type": "2",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({
        error: "Non-JSON response from Bithumb",
        raw: text,
      });
    }

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}