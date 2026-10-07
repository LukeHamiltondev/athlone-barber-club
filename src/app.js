import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { BookingService, BookingError } from "./bookings.js";
import { Store } from "./store.js";
import { CallSession } from "./agent.js";
import { twiml, xml, validSignature, makeSmsSender } from "./twilio.js";
import { describeDate, describeTime, isValidDate, isValidTime, toMinutes } from "./time.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

export function createApp({ config, loadShop, anthropicClient, sendSms: sendSmsOverride, log = console, clock }) {
  const store = new Store(config.dataDir);
  const bookings = new BookingService({ store, getShop: loadShop, clock });
  const sendSms = sendSmsOverride ?? makeSmsSender(config.twilio, log);
  const notifyOwner = config.notifyOwnerBySms && config.ownerMobile ? (text) => sendSms(config.ownerMobile, text) : null;
  const publicDir = path.join(config.root, "public");
  const rate = new Map();

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const xmlResponse = (res, body) => {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml(body));
  };

  async function readBody(req, limit = 20_000) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new BookingError("Request too large.");
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return raw ? JSON.parse(raw) : {};
  }

  function limited(req, key, max, windowMs) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const k = `${key}:${ip}`, now = Date.now();
    const hits = (rate.get(k) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    rate.set(k, hits);
    return hits.length > max;
  }

  function isAdmin(req) {
    const given = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!config.adminPassword || !given) return false;
    const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function twilioOk(req, params) {
    if (!config.twilio.validateSignatures) return true;
    return validSignature(config.twilio.authToken, req.headers["x-twilio-signature"], config.publicUrl + req.url, params);
  }

  function publicShop() {
    const s = loadShop();
    return {
      name: s.name, tagline: s.tagline, address: s.address, mapsUrl: s.mapsUrl, instagram: s.instagram,
      phoneDisplay: s.phoneDisplay, hours: s.hours, maxDaysAhead: s.maxDaysAhead,
      barbers: s.barbers, services: s.services, today: bookings.today(), phoneAgent: config.phoneAgentEnabled,
    };
  }

  function relayTwiml() {
    const shop = loadShop();
    const wsUrl = config.publicUrl.replace(/^http/, "ws") + "/voice/relay";
    const voice = config.voice.name ? ` voice="${xml(config.voice.name)}"` : "";
    return `<Connect action="${xml(config.publicUrl)}/voice/relay-ended"><ConversationRelay url="${xml(wsUrl)}" language="${xml(config.voice.language)}" ttsProvider="${xml(config.voice.ttsProvider)}"${voice} interruptible="any" welcomeGreeting="${xml(`Hi, thanks for calling ${shop.name}. I'm the shop's AI assistant. I can book you in, or help with an existing booking. What can I do for you?`)}" hints="skin fade, beard trim, fade, Athlone" /></Connect>`;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    // ---- Public booking API ----
    if (p === "/api/shop" && req.method === "GET") return json(res, 200, publicShop());

    if (p === "/api/availability" && req.method === "GET") {
      const out = bookings.availability({
        date: url.searchParams.get("date"), serviceId: url.searchParams.get("service"), barberId: url.searchParams.get("barber") || "any",
      });
      return json(res, 200, { date: out.date, times: out.slots.map((s) => s.time), closedReason: out.closedReason });
    }

    if (p === "/api/bookings" && req.method === "POST") {
      if (limited(req, "book", 10, 60 * 60 * 1000)) return json(res, 429, { error: "Too many bookings from this connection. Please ring the shop." });
      const body = await readBody(req);
      if (body.website) return json(res, 400, { error: "Booking rejected." }); // honeypot field bots fill in
      const b = bookings.book({
        serviceId: body.service, date: body.date, time: body.time, barberId: body.barber || "any",
        name: body.name, phone: body.phone, notes: body.notes, source: "website",
      });
      if (config.smsCustomerConfirmations) {
        await sendSms(b.phone, `${loadShop().name}: you're booked for ${b.serviceName} on ${describeDate(b.date)} at ${describeTime(b.start)} (€${b.price}). Ref ${b.id}. To cancel or change, just ring us.`);
      }
      await notifyOwner?.(`New web booking: ${b.name}, ${b.serviceName}, ${describeDate(b.date)} at ${describeTime(b.start)}. ${b.phone}`);
      return json(res, 201, { reference: b.id, service: b.serviceName, date: b.date, day: describeDate(b.date), time: describeTime(b.start), price: b.price });
    }

    // ---- Owner diary API ----
    if (p.startsWith("/api/admin/")) {
      if (limited(req, "admin", 300, 15 * 60 * 1000)) return json(res, 429, { error: "Too many attempts. Wait a few minutes." });
      if (!isAdmin(req)) return json(res, 401, { error: "Wrong password." });

      if (p === "/api/admin/bookings" && req.method === "GET") {
        return json(res, 200, { bookings: store.listBookings({ from: url.searchParams.get("from") || bookings.today(), to: url.searchParams.get("to") || undefined }) });
      }
      const cancel = p.match(/^\/api\/admin\/bookings\/([a-f0-9]+)\/cancel$/);
      if (cancel && req.method === "POST") {
        const b = store.cancelBooking(cancel[1], "owner");
        if (!b) return json(res, 404, { error: "No confirmed booking with that reference." });
        const body = await readBody(req);
        if (body.notifyCustomer) {
          await sendSms(b.phone, `${loadShop().name}: sorry, your ${b.serviceName} on ${describeDate(b.date)} at ${describeTime(b.start)} has been cancelled. Ring us to rebook.`);
        }
        return json(res, 200, { booking: b });
      }
      if (p === "/api/admin/bookings" && req.method === "POST") {
        // Owner adds a walk-in or a booking taken in person. Skips the online notice rules but still checks clashes.
        const body = await readBody(req);
        const b = bookings.book({ serviceId: body.service, date: body.date, time: body.time, barberId: body.barber || "any", name: body.name, phone: body.phone || "+353000000000", notes: body.notes, source: "owner" });
        return json(res, 201, { booking: b });
      }
      if (p === "/api/admin/blocks" && req.method === "GET") return json(res, 200, { blocks: store.listBlocks({ from: bookings.today() }) });
      if (p === "/api/admin/blocks" && req.method === "POST") {
        const body = await readBody(req);
        if (!isValidDate(body.date) || !isValidTime(body.start) || !isValidTime(body.end) || toMinutes(body.end) <= toMinutes(body.start)) {
          return json(res, 400, { error: "Give a date, a start time and a later end time." });
        }
        return json(res, 201, { block: store.addBlock({ date: body.date, start: body.start, end: body.end, barberId: body.barber || null, reason: String(body.reason || "").slice(0, 100) }) });
      }
      const block = p.match(/^\/api\/admin\/blocks\/([a-f0-9]+)$/);
      if (block && req.method === "DELETE") return json(res, store.removeBlock(block[1]) ? 200 : 404, {});
      if (p === "/api/admin/messages" && req.method === "GET") return json(res, 200, { messages: store.listMessages() });
      return json(res, 404, { error: "Not found." });
    }

    // ---- Twilio voice webhooks ----
    if (p.startsWith("/voice/") && req.method === "POST" && config.phoneAgentEnabled) {
      const params = await readBody(req);
      if (!twilioOk(req, params)) {
        res.writeHead(403);
        return res.end();
      }
      if (p === "/voice/incoming") {
        if (config.ownerMobile && config.ringOwnerFirstSeconds > 0) {
          return xmlResponse(res, `<Dial timeout="${config.ringOwnerFirstSeconds}" answerOnBridge="true" action="${xml(config.publicUrl)}/voice/after-owner"><Number>${xml(config.ownerMobile)}</Number></Dial>`);
        }
        return xmlResponse(res, relayTwiml());
      }
      if (p === "/voice/after-owner") {
        if (params.DialCallStatus === "completed") return xmlResponse(res, "<Hangup/>");
        return xmlResponse(res, relayTwiml());
      }
      if (p === "/voice/relay-ended") {
        let handoff = {};
        try { handoff = JSON.parse(params.HandoffData || "{}"); } catch {}
        if (handoff.type === "transfer" && config.ownerMobile) {
          return xmlResponse(res, `<Say>Putting you through now.</Say><Dial timeout="25"><Number>${xml(config.ownerMobile)}</Number></Dial><Say>Sorry, nobody could take the call. We'll ring you back.</Say>`);
        }
        return xmlResponse(res, "<Hangup/>");
      }
    }

    // ---- Static site ----
    if (req.method === "GET" || req.method === "HEAD") {
      let rel = decodeURIComponent(p);
      if (rel === "/") rel = "/index.html";
      if (rel === "/admin") rel = "/admin.html";
      const file = path.normalize(path.join(publicDir, rel));
      if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: "Not found." });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof BookingError) return json(res, 400, { error: err.message });
      if (err instanceof SyntaxError) return json(res, 400, { error: "Malformed request." });
      log.error?.(err);
      json(res, 500, { error: "Something went wrong. Please ring the shop." });
    });
  });

  // ---- ConversationRelay WebSocket: one connection per phone call ----
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const signed = !config.twilio.validateSignatures || validSignature(config.twilio.authToken, req.headers["x-twilio-signature"], config.publicUrl.replace(/^http/, "ws") + req.url, {});
    if (!config.phoneAgentEnabled || url.pathname !== "/voice/relay" || !signed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleCall(ws));
  });

  function handleCall(ws) {
    let call = null;
    let queue = Promise.resolve();
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "setup") {
        call = new CallSession({
          bookings, store, shop: loadShop(), callerNumber: msg.from, ownerMobile: config.ownerMobile,
          client: anthropicClient, model: config.anthropicModel,
          sendSms: config.smsCustomerConfirmations ? sendSms : null, notifyOwner, log,
        });
        log.info?.(`[call] ${msg.callSid} from ${msg.from}`);
      } else if (msg.type === "prompt" && call && msg.last !== false) {
        queue = queue.then(async () => {
          const { spoken, endAction } = await call.handleUtterance(msg.voicePrompt, (token, last) => send({ type: "text", token, last }));
          if (endAction) {
            // Give the voice time to finish the goodbye before ending the session.
            const ms = Math.min(8000, 800 + spoken.length * 65);
            setTimeout(() => send({ type: "end", handoffData: JSON.stringify(endAction) }), ms);
          }
        });
      } else if (msg.type === "interrupt" && call) {
        call.interrupt(msg.utteranceUntilInterrupt);
      } else if (msg.type === "error") {
        log.error?.(`[call] relay error: ${msg.description}`);
      }
    });
    ws.on("close", () => {
      if (call) log.info?.(`[call] ended\n${call.transcript.join("\n")}`);
    });
  }

  return { server, store, bookings };
}
