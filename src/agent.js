import Anthropic from "@anthropic-ai/sdk";
import { BookingError } from "./bookings.js";
import { addDays, describeDate, describeTime, nowInZone, dayKey } from "./time.js";
import { normalisePhone, isPlausiblePhone } from "./store.js";

const MAX_TOOL_ROUNDS = 6;

function tool(name, description, properties, required = Object.keys(properties)) {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

function buildTools({ canTransfer }) {
  const tools = [
    tool("check_availability", "List free start times for a service on one date. Always call this before offering times; never guess.", {
      date: { type: "string", description: "YYYY-MM-DD" },
      service_id: { type: "string" },
      barber_id: { type: "string", description: 'A barber id, or "any".' },
    }),
    tool("create_booking", "Book an appointment. Only call after the caller has confirmed the service, day, time, name and number you read back to them.", {
      service_id: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, 24-hour, exactly as returned by check_availability" },
      barber_id: { type: "string", description: 'A barber id, or "any".' },
      customer_name: { type: "string" },
      customer_phone: { type: "string", description: "Mobile number for the confirmation text. Use the caller's number unless they give another." },
      notes: { type: "string", description: "Anything the barber should know, or an empty string." },
    }),
    tool("find_my_bookings", "List upcoming bookings made under the number the caller is ringing from.", {}),
    tool("cancel_booking", "Cancel one of the caller's own upcoming bookings, by its reference from find_my_bookings. Confirm with the caller first.", {
      booking_id: { type: "string" },
    }),
    tool("take_message", "Leave a message for the owner, who will ring back.", {
      caller_name: { type: "string" },
      callback_number: { type: "string" },
      message: { type: "string" },
    }),
    tool("end_call", "Hang up after you have said goodbye.", {}),
  ];
  if (canTransfer) {
    tools.push(tool("transfer_to_owner", "Put the caller through to the owner's mobile, for things you can't handle or when they ask for a person.", {
      reason: { type: "string" },
    }));
  }
  return tools;
}

export function buildSystemPrompt(shop, { callerNumber, canTransfer, now = new Date() }) {
  const today = nowInZone(shop.timezone, now);
  const calendar = Array.from({ length: 15 }, (_, i) => {
    const d = addDays(today.date, i);
    const h = shop.hours[dayKey(d)];
    return `${d} = ${describeDate(d)}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}: ${h ? `open ${h[0]}-${h[1]}` : "closed"}`;
  }).join("\n");
  const services = shop.services.map((s) => `- ${s.id}: ${s.name}, ${s.minutes} min, €${s.price}. ${s.description}`).join("\n");
  const barbers = shop.barbers.map((b) => `- ${b.id}: ${b.name}`).join("\n");

  return `You are the receptionist answering the phone for ${shop.name}, a barbershop in Athlone, Ireland. You are an AI assistant; if anyone asks, say so plainly. Your job is to book, move or cancel appointments, answer simple questions about the shop, and take messages for the owner.

How you speak: everything you write is read aloud by a text-to-speech voice on a phone call. Use short, warm, natural sentences, like a friendly Irish receptionist. No lists, symbols, emojis or markdown. Say times like "half two" or "2:30" and dates like "Thursday the 9th". Offer at most three times at once. Ask one question at a time.

Booking: work out the service, the day and a time. Call check_availability before offering any time, and only offer times it returned. Before booking, read back the service, day, time, name and the mobile number for the text, and wait for a yes. After booking, tell them they'll get a text confirmation and give the price. To move a booking, book the new time first, then cancel the old one.

Cancelling: you can only see and cancel bookings made under the number the caller is ringing from. If they booked under another number, take a message for the owner instead.

Stay on topic. If the caller asks for the owner, has a complaint, or wants something you can't do, ${canTransfer ? "offer to put them through to the owner with transfer_to_owner, or take a message" : "take a message with take_message"}. When the caller is finished, say a short goodbye and then call end_call.

Shop details:
Address: ${shop.address}
Prices are in euro, pay in the shop.

Services (id: name, length, price):
${services}

Barbers (id: name). If the caller has no preference use "any":
${barbers}

Next 15 days (date = spoken day: hours):
${calendar}

Right now it is ${describeTime(`${String(Math.floor(today.minutes / 60)).padStart(2, "0")}:${String(today.minutes % 60).padStart(2, "0")}`)} on ${describeDate(today.date)}.
The caller is ringing from ${callerNumber ? callerNumber : "a withheld number, so ask for a mobile number when booking"}.`;
}

// One phone call. Holds the conversation and runs Claude with the shop's tools.
export class CallSession {
  constructor({ bookings, store, shop, callerNumber, ownerMobile, client, model, sendSms, notifyOwner, log = console }) {
    this.bookings = bookings;
    this.store = store;
    this.shop = shop;
    this.callerNumber = isPlausiblePhone(callerNumber) ? normalisePhone(callerNumber) : "";
    this.canTransfer = Boolean(ownerMobile);
    this.client = client ?? new Anthropic();
    this.model = model;
    this.sendSms = sendSms;
    this.notifyOwner = notifyOwner;
    this.log = log;
    this.messages = [];
    this.tools = buildTools({ canTransfer: this.canTransfer });
    this.system = buildSystemPrompt(shop, { callerNumber: this.callerNumber, canTransfer: this.canTransfer });
    this.endAction = null; // { type: "hangup" } | { type: "transfer", reason }
    this.current = null;
    this.transcript = [];
  }

  pushUser(content) {
    const last = this.messages.at(-1);
    if (last?.role === "user" && typeof last.content === "string" && typeof content === "string") {
      last.content += "\n" + content;
    } else {
      this.messages.push({ role: "user", content });
    }
  }

  // Caller spoke. Streams the reply through speak(token, last). Resolves when the turn is done.
  async handleUtterance(text, speak) {
    this.transcript.push(`Caller: ${text}`);
    this.pushUser(text);
    let spoken = "";
    let saidHoldOn = false;
    const turn = { aborted: false };
    this.current = turn;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS && !turn.aborted; round++) {
        const stream = this.client.beta.messages.stream({
          model: this.model,
          max_tokens: 2048,
          output_config: { effort: "low" },
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: this.system,
          tools: this.tools,
          messages: this.messages,
        });
        turn.stream = stream;
        stream.on("text", (delta) => {
          if (turn.aborted) return;
          spoken += delta;
          speak(delta, false);
        });
        stream.on("streamEvent", (ev) => {
          if (!turn.aborted && !saidHoldOn && ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && !spoken.trim()) {
            saidHoldOn = true;
            speak("One moment. ", false);
          }
        });

        const msg = await stream.finalMessage();
        if (turn.aborted) break;
        this.messages.push({ role: "assistant", content: msg.content });

        if (msg.stop_reason === "refusal") {
          speak("Sorry, I can't help with that one. Is there anything else I can do for you?", false);
          break;
        }
        if (msg.stop_reason !== "tool_use") break;

        const results = [];
        for (const block of msg.content) {
          if (block.type !== "tool_use") continue;
          const { content, isError } = await this.runTool(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
        }
        this.messages.push({ role: "user", content: results });
        if (this.endAction) {
          // Let Claude say goodbye / "putting you through" after the tool result.
          continue;
        }
      }
    } catch (err) {
      if (!turn.aborted) {
        this.log.error?.("[agent] turn failed", err);
        speak("Sorry, I'm having a bit of trouble on my end. I'll make sure the owner gets back to you.", false);
        this.endAction ??= { type: this.canTransfer ? "transfer" : "hangup", reason: "agent error" };
      }
    } finally {
      if (this.current === turn) this.current = null;
    }

    if (turn.aborted) {
      // Keep the history valid and record only what the caller actually heard.
      const heard = turn.heard ?? spoken;
      if (this.messages.at(-1)?.role === "user" && heard.trim()) this.messages.push({ role: "assistant", content: heard });
    }
    if (spoken.trim()) this.transcript.push(`Receptionist: ${spoken.trim()}`);
    speak("", true);
    return { spoken, endAction: this.endAction };
  }

  // Caller talked over the receptionist.
  interrupt(heardSoFar) {
    const turn = this.current;
    if (!turn) return;
    turn.aborted = true;
    turn.heard = heardSoFar;
    turn.stream?.abort();
  }

  async runTool(name, input) {
    try {
      const out = await this.dispatch(name, input);
      return { content: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BookingError) return { content: err.message, isError: true };
      this.log.error?.(`[agent] tool ${name} failed`, err);
      return { content: "That didn't work because of a system problem. Offer to take a message.", isError: true };
    }
  }

  async dispatch(name, input) {
    switch (name) {
      case "check_availability": {
        const { slots, closedReason } = this.bookings.availability({ date: input.date, serviceId: input.service_id, barberId: input.barber_id });
        return slots.length
          ? { date: input.date, day: describeDate(input.date), free_times: slots.map((s) => s.time) }
          : { date: input.date, free_times: [], reason: closedReason };
      }
      case "create_booking": {
        const b = this.bookings.book({
          serviceId: input.service_id, date: input.date, time: input.time, barberId: input.barber_id,
          name: input.customer_name, phone: input.customer_phone, notes: input.notes, source: "phone",
        });
        this.transcript.push(`[booked ${b.id}]`);
        await this.confirmToCustomer(b);
        await this.notifyOwner?.(`New phone booking: ${b.name}, ${b.serviceName}, ${describeDate(b.date)} at ${describeTime(b.start)}. ${b.phone}`);
        return { booked: true, reference: b.id, day: describeDate(b.date), time: describeTime(b.start), price_eur: b.price, text_sent_to: b.phone };
      }
      case "find_my_bookings": {
        if (!this.callerNumber) return { bookings: [], note: "The caller's number is withheld, so bookings can't be looked up." };
        return {
          bookings: this.bookings.upcomingFor(this.callerNumber).map((b) => ({
            reference: b.id, service: b.serviceName, day: describeDate(b.date), date: b.date, time: describeTime(b.start), name: b.name,
          })),
        };
      }
      case "cancel_booking": {
        if (!this.callerNumber) throw new BookingError("The caller's number is withheld, so bookings can't be cancelled by phone. Take a message.");
        const b = this.bookings.cancelAsCustomer(input.booking_id, this.callerNumber, "phone");
        this.transcript.push(`[cancelled ${b.id}]`);
        await this.notifyOwner?.(`Cancelled by phone: ${b.name}, ${b.serviceName}, ${describeDate(b.date)} at ${describeTime(b.start)}.`);
        return { cancelled: true, day: describeDate(b.date), time: describeTime(b.start) };
      }
      case "take_message": {
        const m = this.store.addMessage({
          callerName: input.caller_name, callbackNumber: input.callback_number || this.callerNumber, message: input.message, via: "phone",
        });
        await this.notifyOwner?.(`Message from ${m.callerName} (${m.callbackNumber}): ${m.message}`);
        return { saved: true };
      }
      case "transfer_to_owner":
        if (!this.canTransfer) throw new BookingError("Transfers aren't set up. Take a message instead.");
        this.endAction = { type: "transfer", reason: input.reason };
        return { ok: true, note: "Tell the caller you're putting them through now. The transfer happens when you finish speaking." };
      case "end_call":
        this.endAction = { type: "hangup" };
        return { ok: true, note: "The call ends when you finish speaking. Do not say anything else unless you haven't said goodbye." };
      default:
        throw new BookingError(`Unknown tool ${name}.`);
    }
  }

  async confirmToCustomer(b) {
    await this.sendSms?.(
      b.phone,
      `${this.shop.name}: you're booked for ${b.serviceName} on ${describeDate(b.date)} at ${describeTime(b.start)} (€${b.price}). Ref ${b.id}. To cancel or change, just ring us.`,
    );
  }
}
