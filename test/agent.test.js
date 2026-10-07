import test from "node:test";
import assert from "node:assert/strict";
import { BookingService } from "../src/bookings.js";
import { Store } from "../src/store.js";
import { CallSession, buildSystemPrompt } from "../src/agent.js";
import { shop, fixedClock, tmpDir, fakeClient, toolUse, text } from "./helpers.js";

function session(script, extra = {}) {
  const store = new Store(tmpDir());
  const bookings = new BookingService({ store, getShop: () => shop, clock: fixedClock });
  const sms = [];
  const client = fakeClient(script);
  const call = new CallSession({
    bookings, store, shop, callerNumber: "+353871234567", ownerMobile: "+353860000000", client, model: "claude-opus-5-5",
    sendSms: async (to, body) => sms.push({ to, body }), notifyOwner: async (body) => sms.push({ to: "owner", body }), log: { error() {}, info() {} }, ...extra,
  });
  return { call, store, bookings, sms, client };
}

const collect = () => { const out = []; return { out, speak: (t) => out.push(t) }; };

test("system prompt gives the model real dates and the caller's number", () => {
  const p = buildSystemPrompt(shop, { callerNumber: "+353871234567", canTransfer: true, now: fixedClock() });
  assert.match(p, /2026-10-08 = Thursday, 8 October \(tomorrow\): open 09:00-20:00/);
  assert.match(p, /2026-10-11 = Sunday, 11 October: closed/);
  assert.match(p, /ringing from \+353871234567/);
});

test("a caller books a fade: availability, confirmation, booking, texts", async () => {
  const { call, store, sms, client } = session([
    { content: [toolUse("t1", "check_availability", { date: "2026-10-08", service_id: "skin-fade", barber_id: "any" })] },
    { content: [text("I have 2, half 2 or 3 tomorrow. Which suits?")] },
    { content: [toolUse("t2", "create_booking", { service_id: "skin-fade", date: "2026-10-08", time: "14:30", barber_id: "any", customer_name: "Ciarán", customer_phone: "+353871234567", notes: "" })] },
    { content: [text("You're all booked for half 2 tomorrow. That's 20 euro.")] },
  ]);
  const a = collect();
  await call.handleUtterance("Can I get a skin fade tomorrow afternoon?", a.speak);
  assert.equal(a.out[0], "One moment. ");
  assert.ok(a.out.join("").includes("half 2"));
  // The model saw real free times from the diary.
  const toolResult = client.calls[1].messages.at(-1).content[0];
  assert.ok(JSON.parse(toolResult.content).free_times.includes("14:30"));

  await call.handleUtterance("Half 2 please, name's Ciarán, this number's grand.", collect().speak);
  const [b] = store.listBookings();
  assert.equal(b.start, "14:30");
  assert.equal(b.source, "phone");
  assert.ok(sms.some((m) => m.to === "+353871234567" && /Skin fade/.test(m.body)));
  assert.ok(sms.some((m) => m.to === "owner" && /New phone booking/.test(m.body)));
  // Requests use the defaults from the Claude API guidance.
  assert.equal(client.calls[0].model, "claude-opus-5-5");
  assert.equal(client.calls[0].fallbacks, "default");
  assert.ok(client.calls[0].tools.every((t) => t.strict === true));
});

test("a taken slot comes back to the model as an error, not a crash", async () => {
  const { call, bookings, client } = session([
    { content: [toolUse("t1", "create_booking", { service_id: "haircut", date: "2026-10-08", time: "12:00", barber_id: "any", customer_name: "B", customer_phone: "0872222222", notes: "" })] },
    { content: [text("Sorry, 12 has just gone. Would 12:30 do?")] },
  ]);
  bookings.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "A", phone: "0871111111", source: "web" });
  await call.handleUtterance("12 tomorrow", collect().speak);
  const result = client.calls[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /no longer free/);
});

test("callers only see and cancel bookings under their own number", async () => {
  const { call, bookings, client } = session([
    { content: [toolUse("t1", "find_my_bookings", {})] },
    { content: [text("I see one for Thursday.")] },
    { content: [toolUse("t2", "cancel_booking", { booking_id: "PLACEHOLDER" })] },
    { content: [text("Done.")] },
  ]);
  const mine = bookings.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "Me", phone: "087 123 4567", source: "web" });
  const theirs = bookings.book({ serviceId: "haircut", date: "2026-10-08", time: "15:00", name: "Them", phone: "0869999999", source: "web" });
  await call.handleUtterance("What bookings do I have?", collect().speak);
  const found = JSON.parse(client.calls[1].messages.at(-1).content[0].content).bookings;
  assert.deepEqual(found.map((b) => b.reference), [mine.id]);

  // Trying to cancel someone else's booking fails.
  const script = client.calls; // keep reference
  call.client = fakeClient([
    { content: [toolUse("t2", "cancel_booking", { booking_id: theirs.id })] },
    { content: [text("I can't find that one under your number.")] },
  ]);
  await call.handleUtterance("Cancel the 3 o'clock", collect().speak);
  assert.equal(bookings.store.getBooking(theirs.id).status, "confirmed");
  assert.ok(script.length > 0);
});

test("end_call and transfer set the end action after the goodbye", async () => {
  const { call } = session([
    { content: [text("Bye now!"), toolUse("t1", "end_call", {})] },
    { content: [] },
  ]);
  const r = await call.handleUtterance("That's all, thanks", collect().speak);
  assert.deepEqual(r.endAction, { type: "hangup" });

  const { call: c2 } = session([
    { content: [toolUse("t1", "transfer_to_owner", { reason: "complaint" })] },
    { content: [text("Putting you through to the owner now.")] },
  ]);
  const r2 = await c2.handleUtterance("I want to talk to the owner", collect().speak);
  assert.equal(r2.endAction.type, "transfer");
});

test("messages are saved and texted to the owner", async () => {
  const { call, store, sms } = session([
    { content: [toolUse("t1", "take_message", { caller_name: "Pat", callback_number: "0861234567", message: "Can he do a wedding party of 6?" })] },
    { content: [text("I'll pass that on.")] },
  ]);
  await call.handleUtterance("Can you pass on a message?", collect().speak);
  assert.equal(store.listMessages()[0].callerName, "Pat");
  assert.ok(sms.some((m) => m.to === "owner" && /wedding/.test(m.body)));
});

test("transfer isn't offered when no owner mobile is set", () => {
  const { call } = session([], { ownerMobile: "" });
  assert.ok(!call.tools.some((t) => t.name === "transfer_to_owner"));
});
