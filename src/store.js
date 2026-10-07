import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// A single JSON file is plenty for one shop's diary. Writes go to a temp file
// and are renamed into place so a crash mid-write can't corrupt the diary.
export class Store {
  constructor(dir) {
    this.file = path.join(dir, "bookings.json");
    fs.mkdirSync(dir, { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { bookings: [], blocks: [], messages: [] };
    this.data.messages ??= [];
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  activeBookingsOn(date) {
    return this.data.bookings.filter((b) => b.date === date && b.status === "confirmed");
  }

  blocksOn(date) {
    return this.data.blocks.filter((b) => b.date === date);
  }

  addBooking(fields) {
    const booking = {
      id: crypto.randomBytes(4).toString("hex"),
      status: "confirmed",
      createdAt: new Date().toISOString(),
      ...fields,
    };
    this.data.bookings.push(booking);
    this.save();
    return booking;
  }

  getBooking(id) {
    return this.data.bookings.find((b) => b.id === id);
  }

  cancelBooking(id, by) {
    const b = this.getBooking(id);
    if (!b || b.status !== "confirmed") return null;
    b.status = "cancelled";
    b.cancelledAt = new Date().toISOString();
    b.cancelledBy = by;
    this.save();
    return b;
  }

  listBookings({ from, to } = {}) {
    return this.data.bookings
      .filter((b) => (!from || b.date >= from) && (!to || b.date <= to))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }

  upcomingForPhone(phone, today) {
    const key = normalisePhone(phone);
    return this.data.bookings
      .filter((b) => b.status === "confirmed" && b.date >= today && normalisePhone(b.phone) === key)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }

  addBlock(fields) {
    const block = { id: crypto.randomBytes(4).toString("hex"), ...fields };
    this.data.blocks.push(block);
    this.save();
    return block;
  }

  removeBlock(id) {
    const before = this.data.blocks.length;
    this.data.blocks = this.data.blocks.filter((b) => b.id !== id);
    this.save();
    return this.data.blocks.length !== before;
  }

  listBlocks({ from } = {}) {
    return this.data.blocks.filter((b) => !from || b.date >= from).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }

  addMessage(fields) {
    const msg = { id: crypto.randomBytes(4).toString("hex"), createdAt: new Date().toISOString(), ...fields };
    this.data.messages.push(msg);
    this.save();
    return msg;
  }

  listMessages() {
    return [...this.data.messages].reverse();
  }
}

// Irish numbers: "087 123 4567", "+353 87 123 4567" and "00353871234567" all match.
export function normalisePhone(phone = "") {
  let p = String(phone).replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (p.startsWith("0")) p = "+353" + p.slice(1);
  return p;
}

export function isPlausiblePhone(phone) {
  return /^\+\d{9,15}$/.test(normalisePhone(phone));
}
