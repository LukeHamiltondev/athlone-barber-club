import { nowInZone, toMinutes, toHHMM, isValidDate, isValidTime, dayKey, daysBetween } from "./time.js";
import { normalisePhone, isPlausiblePhone } from "./store.js";

export class BookingError extends Error {}

// The one place that decides what is bookable. The website, the phone
// receptionist and the owner's diary all go through this.
export class BookingService {
  constructor({ store, getShop, clock = () => new Date() }) {
    this.store = store;
    this.getShop = getShop;
    this.clock = clock;
  }

  get shop() {
    return this.getShop();
  }

  today() {
    return nowInZone(this.shop.timezone, this.clock()).date;
  }

  service(id) {
    const s = this.shop.services.find((x) => x.id === id);
    if (!s) throw new BookingError(`Unknown service "${id}".`);
    return s;
  }

  barberIds(barberId) {
    const all = this.shop.barbers.map((b) => b.id);
    if (!barberId || barberId === "any") return all;
    if (!all.includes(barberId)) throw new BookingError(`Unknown barber "${barberId}".`);
    return [barberId];
  }

  // Why a date can't be booked, or null if it can.
  dateProblem(date) {
    if (!isValidDate(date)) return "That isn't a valid date.";
    const ahead = daysBetween(this.today(), date);
    if (ahead < 0) return "That date has already passed.";
    if (ahead > this.shop.maxDaysAhead) return `Bookings open ${this.shop.maxDaysAhead} days ahead.`;
    if (!this.shop.hours[dayKey(date)]) return "The shop is closed that day.";
    return null;
  }

  isBarberFree(barberId, date, start, end, ignoreBookingId) {
    const clash = (s, e) => start < e && s < end;
    for (const b of this.store.activeBookingsOn(date)) {
      if (b.id !== ignoreBookingId && b.barberId === barberId && clash(toMinutes(b.start), toMinutes(b.end))) return false;
    }
    for (const bl of this.store.blocksOn(date)) {
      if ((!bl.barberId || bl.barberId === barberId) && clash(toMinutes(bl.start), toMinutes(bl.end))) return false;
    }
    return true;
  }

  // Returns [{ time: "09:15", barberIds: [...] }] for every start time that fits.
  availability({ date, serviceId, barberId }) {
    const problem = this.dateProblem(date);
    if (problem) return { date, slots: [], closedReason: problem };
    const svc = this.service(serviceId);
    const barbers = this.barberIds(barberId);
    const [open, close] = this.shop.hours[dayKey(date)].map(toMinutes);
    const now = nowInZone(this.shop.timezone, this.clock());
    const earliest = date === now.date ? now.minutes + this.shop.minNoticeMinutes : 0;
    const step = this.shop.slotIntervalMinutes;

    const slots = [];
    for (let t = open; t + svc.minutes <= close; t += step) {
      if (t < earliest) continue;
      const free = barbers.filter((id) => this.isBarberFree(id, date, t, t + svc.minutes));
      if (free.length) slots.push({ time: toHHMM(t), barberIds: free });
    }
    return { date, slots, closedReason: slots.length ? null : "Fully booked that day." };
  }

  book({ serviceId, date, time, barberId, name, phone, notes = "", source }) {
    name = String(name || "").trim().slice(0, 80);
    if (!name) throw new BookingError("A name is needed for the booking.");
    if (!isPlausiblePhone(phone)) throw new BookingError("That phone number doesn't look right.");
    if (!isValidTime(time)) throw new BookingError("That isn't a valid time.");
    const svc = this.service(serviceId);
    const { slots, closedReason } = this.availability({ date, serviceId, barberId });
    const slot = slots.find((s) => s.time === time);
    if (!slot) throw new BookingError(closedReason && !slots.length ? closedReason : "That time is no longer free.");

    const start = toMinutes(time);
    return this.store.addBooking({
      serviceId: svc.id,
      serviceName: svc.name,
      price: svc.price,
      barberId: slot.barberIds[0],
      date,
      start: time,
      end: toHHMM(start + svc.minutes),
      name,
      phone: normalisePhone(phone),
      notes: String(notes).slice(0, 300),
      source,
    });
  }

  upcomingFor(phone) {
    return this.store.upcomingForPhone(phone, this.today());
  }

  // Customers (website or phone) may only cancel their own booking.
  cancelAsCustomer(bookingId, phone, source) {
    const b = this.store.getBooking(bookingId);
    if (!b || b.status !== "confirmed" || normalisePhone(b.phone) !== normalisePhone(phone)) {
      throw new BookingError("No upcoming booking with that reference for this phone number.");
    }
    return this.store.cancelBooking(bookingId, source);
  }

  barberName(id) {
    return this.shop.barbers.find((b) => b.id === id)?.name ?? id;
  }
}
