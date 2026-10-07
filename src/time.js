// All booking times are stored as the shop's local wall-clock date ("2026-10-07")
// and time ("14:30"), so they read the same to the owner, the caller and the site.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function nowInZone(timezone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function dayKey(date) {
  return DAY_KEYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

export function describeDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IE", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
}

export function describeTime(hhmm) {
  const mins = toMinutes(hhmm);
  const h = Math.floor(mins / 60), m = mins % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}
