import test from "node:test";
import assert from "node:assert/strict";
import { BookingService, BookingError } from "../src/bookings.js";
import { Store } from "../src/store.js";
import { shop, fixedClock, tmpDir } from "./helpers.js";

const make = (s = shop) => new BookingService({ store: new Store(tmpDir()), getShop: () => s, clock: fixedClock });

test("today's slots start after the notice period", () => {
  const svc = make();
  const { slots } = svc.availability({ date: "2026-10-07", serviceId: "haircut", barberId: "any" });
  assert.equal(slots[0].time, "11:30"); // 11:00 now + 30 min notice
  assert.equal(slots.at(-1).time, "17:30"); // 30 min cut must finish by 18:00
});

test("closed days, past days and days too far ahead have no slots", () => {
  const svc = make();
  assert.match(svc.availability({ date: "2026-10-11", serviceId: "haircut" }).closedReason, /closed/);
  assert.match(svc.availability({ date: "2026-10-06", serviceId: "haircut" }).closedReason, /passed/);
  assert.match(svc.availability({ date: "2026-12-25", serviceId: "haircut" }).closedReason, /days ahead/);
});

test("a booking blocks overlapping slots and double booking is refused", () => {
  const svc = make();
  svc.book({ serviceId: "cut-beard", date: "2026-10-08", time: "10:00", name: "Seán", phone: "087 123 4567", source: "test" });
  const times = svc.availability({ date: "2026-10-08", serviceId: "haircut" }).slots.map((s) => s.time);
  assert.ok(!times.includes("10:00") && !times.includes("10:30") && !times.includes("09:45"));
  assert.ok(times.includes("09:30") && times.includes("10:45"));
  assert.throws(() => svc.book({ serviceId: "beard", date: "2026-10-08", time: "10:15", name: "Other", phone: "0861111111", source: "test" }), BookingError);
});

test("blocked time can't be booked", () => {
  const svc = make();
  svc.store.addBlock({ date: "2026-10-08", start: "13:00", end: "14:00", barberId: null });
  const times = svc.availability({ date: "2026-10-08", serviceId: "beard" }).slots.map((s) => s.time);
  assert.ok(!times.includes("13:00") && !times.includes("13:45") && times.includes("14:00") && times.includes("12:45"));
});

test("with two barbers, 'any' fills the second chair", () => {
  const two = { ...shop, barbers: [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
  const svc = make(two);
  const b1 = svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "One", phone: "0871111111", source: "t" });
  const b2 = svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "Two", phone: "0872222222", source: "t" });
  assert.deepEqual([b1.barberId, b2.barberId], ["a", "b"]);
  assert.throws(() => svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "Three", phone: "0873333333", source: "t" }));
});

test("customers can only cancel their own bookings", () => {
  const svc = make();
  const b = svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "Seán", phone: "087 123 4567", source: "t" });
  assert.throws(() => svc.cancelAsCustomer(b.id, "0869999999", "phone"), BookingError);
  assert.equal(svc.cancelAsCustomer(b.id, "+353871234567", "phone").status, "cancelled");
  assert.ok(svc.availability({ date: "2026-10-08", serviceId: "haircut" }).slots.some((s) => s.time === "12:00"));
});

test("bad input is rejected with a readable reason", () => {
  const svc = make();
  assert.throws(() => svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "", phone: "0871234567" }), /name/);
  assert.throws(() => svc.book({ serviceId: "haircut", date: "2026-10-08", time: "12:00", name: "X", phone: "12" }), /phone/);
  assert.throws(() => svc.book({ serviceId: "perm", date: "2026-10-08", time: "12:00", name: "X", phone: "0871234567" }), /Unknown service/);
});
