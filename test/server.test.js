import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { root, shop, fixedClock, tmpDir, fakeClient, toolUse, text } from "./helpers.js";

async function start(overrides = {}, script = []) {
  const sms = [];
  const config = {
    root, port: 0, publicUrl: "", adminPassword: "secret", dataDir: tmpDir(), anthropicModel: "claude-opus-5-5",
    twilio: { accountSid: "", authToken: "tok", phoneNumber: "", validateSignatures: true },
    phoneAgentEnabled: true, ownerMobile: "+353860000000", ringOwnerFirstSeconds: 15, notifyOwnerBySms: true, smsCustomerConfirmations: true,
    voice: { language: "en-GB", ttsProvider: "ElevenLabs", name: "" }, ...overrides,
  };
  const app = createApp({ config, loadShop: () => shop, anthropicClient: fakeClient(script), sendSms: async (to, body) => sms.push({ to, body }), clock: fixedClock, log: { info() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  return { ...app, base, sms, config, close: () => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); }) };
}

const sign = (token, url, params) =>
  crypto.createHmac("sha1", token).update(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url)).digest("base64");

test("website: shop info, availability, booking, double booking refused", async () => {
  const s = await start();
  try {
    const info = await (await fetch(`${s.base}/api/shop`)).json();
    assert.equal(info.today, "2026-10-07");
    const av = await (await fetch(`${s.base}/api/availability?date=2026-10-08&service=haircut`)).json();
    assert.ok(av.times.includes("10:00"));
    const body = { service: "haircut", date: "2026-10-08", time: "10:00", name: "Seán", phone: "087 123 4567" };
    const r = await fetch(`${s.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(r.status, 201);
    assert.equal(s.sms.length, 2); // customer + owner
    const again = await fetch(`${s.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, phone: "0861111111" }) });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /no longer free/);
    const page = await fetch(`${s.base}/`);
    assert.match(await page.text(), /Athlone Barber Club/);
    assert.equal((await fetch(`${s.base}/../config/shop.json`)).status, 404);
  } finally { await s.close(); }
});

test("owner diary needs the password", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/api/admin/bookings`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/admin/bookings`, { headers: { Authorization: "Bearer nope" } })).status, 401);
    const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
    const block = await fetch(`${s.base}/api/admin/blocks`, { method: "POST", headers: auth, body: JSON.stringify({ date: "2026-10-08", start: "13:00", end: "14:00" }) });
    assert.equal(block.status, 201);
    const av = await (await fetch(`${s.base}/api/availability?date=2026-10-08&service=beard`)).json();
    assert.ok(!av.times.includes("13:00"));
    const list = await (await fetch(`${s.base}/api/admin/bookings`, { headers: auth })).json();
    assert.deepEqual(list.bookings, []);
  } finally { await s.close(); }
});

test("voice webhook rejects unsigned requests and rings the owner first", async () => {
  const s = await start();
  try {
    const params = { CallSid: "CA1", From: "+353871234567" };
    const unsigned = await fetch(`${s.base}/voice/incoming`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    assert.equal(unsigned.status, 403);
    const ok = await fetch(`${s.base}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sign("tok", `${s.base}/voice/incoming`, params) },
      body: new URLSearchParams(params),
    });
    const x = await ok.text();
    assert.match(x, /<Dial timeout="15"/);
    assert.match(x, /\+353860000000/);

    const after = { DialCallStatus: "no-answer" };
    const ai = await (await fetch(`${s.base}/voice/after-owner`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sign("tok", `${s.base}/voice/after-owner`, after) },
      body: new URLSearchParams(after),
    })).text();
    assert.match(ai, /<ConversationRelay url="ws:\/\/127\.0\.0\.1:\d+\/voice\/relay"/);
    assert.match(ai, /welcomeGreeting="Hi, thanks for calling Athlone Barber Club/);
  } finally { await s.close(); }
});

test("a phone call over ConversationRelay books an appointment", async () => {
  const s = await start({}, [
    { content: [toolUse("t1", "create_booking", { service_id: "beard", date: "2026-10-08", time: "16:00", barber_id: "any", customer_name: "Niall", customer_phone: "+353871234567", notes: "" })] },
    { content: [text("Grand, you're booked for 4 tomorrow.")] },
  ]);
  try {
    const path = "/voice/relay";
    const ws = new WebSocket(s.base.replace("http", "ws") + path, { headers: { "X-Twilio-Signature": sign("tok", s.base.replace("http", "ws") + path, {}) } });
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    const got = [];
    const done = new Promise((r) => ws.on("message", (m) => { const msg = JSON.parse(m); got.push(msg); if (msg.last) r(); }));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA1", from: "+353871234567" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Beard trim at 4 tomorrow, Niall", last: true }));
    await done;
    ws.close();
    assert.match(got.map((g) => g.token).join(""), /booked for 4/);
    assert.equal(s.store.listBookings()[0].name, "Niall");
  } finally { await s.close(); }
});

test("unsigned WebSocket connections are refused", async () => {
  const s = await start();
  try {
    const ws = new WebSocket(s.base.replace("http", "ws") + "/voice/relay");
    const err = await new Promise((r) => { ws.on("error", r); ws.on("open", () => r(null)); });
    assert.ok(err);
  } finally { await s.close(); }
});

test("with the phone agent off, voice routes are not served", async () => {
  const s = await start({ phoneAgentEnabled: false });
  try {
    const params = { CallSid: "CA1", From: "+353871234567" };
    const r = await fetch(`${s.base}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sign("tok", `${s.base}/voice/incoming`, params) },
      body: new URLSearchParams(params),
    });
    assert.equal(r.status, 404);
    assert.equal((await (await fetch(`${s.base}/api/shop`)).json()).phoneAgent, false);
    const ws = new WebSocket(s.base.replace("http", "ws") + "/voice/relay", { headers: { "X-Twilio-Signature": sign("tok", s.base.replace("http", "ws") + "/voice/relay", {}) } });
    assert.ok(await new Promise((res) => { ws.on("error", res); ws.on("open", () => res(null)); }));
  } finally { await s.close(); }
});
