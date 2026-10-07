import crypto from "node:crypto";

export const xml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

// https://www.twilio.com/docs/usage/security#validating-requests
export function validSignature(authToken, signature, url, params) {
  if (!authToken || !signature) return false;
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function makeSmsSender({ accountSid, authToken, phoneNumber }, log = console) {
  return async function sendSms(to, body) {
    if (!accountSid || !authToken || !phoneNumber || !to) {
      log.info?.(`[sms skipped, Twilio not configured] to ${to}: ${body}`);
      return false;
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: phoneNumber, Body: body }),
    });
    if (!res.ok) {
      log.error?.(`[sms failed] ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  };
}
