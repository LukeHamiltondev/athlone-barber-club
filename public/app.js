const $ = (s, el = document) => el.querySelector(s);
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const GALLERY_COUNT = 8;

const state = { shop: null, service: null, barber: "any", date: null, time: null };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayKeyOf = (date) => DAY_KEYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
const fmtDay = (date, opts) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IE", { timeZone: "UTC", ...opts });
const fmtTime = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
const price = (n) => `€${n}`;

function pressed(container, btn) {
  container.querySelectorAll("[aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
}

// Photos: drop Instagram images into public/images/gallery as 1.jpg ... 8.jpg. 1.jpg is also the big hero photo.
function placeholderOnError(img) {
  img.addEventListener("error", () => { img.src = "images/gallery/placeholder.svg"; }, { once: true });
}

function renderGallery(shop) {
  const g = $("#gallery");
  for (let i = 1; i <= GALLERY_COUNT; i++) {
    const a = document.createElement("a");
    a.href = shop.instagram;
    a.target = "_blank";
    a.rel = "noopener";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `Haircut by Athlone Barber Club, photo ${i}`;
    placeholderOnError(img);
    img.src = `images/gallery/${i}.jpg`;
    a.append(img);
    g.append(a);
  }
  document.querySelectorAll("img[data-gallery]").forEach((img) => {
    placeholderOnError(img);
    img.src = `images/gallery/${img.dataset.gallery}.jpg`;
  });
}

function renderShopDetails(shop) {
  const telHref = "tel:" + shop.phoneDisplay.replace(/[^\d+]/g, "");
  const hasPhone = /\d{6,}/.test(shop.phoneDisplay.replace(/\s/g, "")) && !/PLACEHOLDER/.test(shop.phoneDisplay);
  document.querySelectorAll('[data-shop="tel"]').forEach((a) => {
    if (hasPhone) { a.href = telHref; if (a.closest(".phone-line")) a.textContent = shop.phoneDisplay; else a.textContent = `Ring ${shop.phoneDisplay}`; }
  });
  document.querySelectorAll('[data-shop="address"]').forEach((el) => (el.textContent = shop.address));
  document.querySelectorAll('[data-shop="maps"]').forEach((a) => (a.href = shop.mapsUrl));
  document.querySelectorAll('[data-shop="instagram"]').forEach((a) => (a.href = shop.instagram));
  document.querySelectorAll('[data-shop="tagline"]').forEach((el) => (el.textContent = shop.tagline));

  $("#price-list").innerHTML = shop.services.map((s) => `
    <li>
      <div class="price-row"><span class="price-name">${esc(s.name)}</span><span class="price-dots"></span><span class="price-amt">${price(s.price)}</span></div>
      <p class="price-desc">${esc(s.description)} ${s.minutes} minutes.</p>
    </li>`).join("");

  const todayKey = dayKeyOf(shop.today);
  $("#hours").innerHTML = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((k) => {
    const h = shop.hours[k];
    return `<tr class="${k === todayKey ? "today" : ""}"><td>${DAY_NAMES[k]}</td><td>${h ? `${fmtTime(h[0])} to ${fmtTime(h[1])}` : "Closed"}</td></tr>`;
  }).join("");
}

function renderBooking(shop) {
  const services = $("#service-choices");
  services.innerHTML = shop.services.map((s) => `
    <button type="button" class="choice" aria-pressed="false" data-id="${esc(s.id)}">
      <strong>${esc(s.name)}</strong><span>${s.minutes} min, ${price(s.price)}</span>
    </button>`).join("");
  services.addEventListener("click", (e) => {
    const btn = e.target.closest(".choice");
    if (!btn) return;
    pressed(services, btn);
    state.service = shop.services.find((s) => s.id === btn.dataset.id);
    $("#step-day").disabled = false;
    if (state.date) loadTimes(); else updateSummary();
  });

  if (shop.barbers.length > 1) {
    $("#step-barber").hidden = false;
    $('[data-n="day"]').textContent = "3";
    $('[data-n="time"]').textContent = "4";
    $('[data-n="details"]').textContent = "5";
    const barbers = $("#barber-choices");
    barbers.innerHTML = [{ id: "any", name: "Whoever's free first" }, ...shop.barbers]
      .map((b) => `<button type="button" class="choice" aria-pressed="${b.id === "any"}" data-id="${esc(b.id)}"><strong>${esc(b.name)}</strong></button>`).join("");
    barbers.addEventListener("click", (e) => {
      const btn = e.target.closest(".choice");
      if (!btn) return;
      pressed(barbers, btn);
      state.barber = btn.dataset.id;
      if (state.date) loadTimes();
    });
  }

  const days = $("#day-choices");
  const count = Math.min(14, shop.maxDaysAhead + 1);
  days.innerHTML = Array.from({ length: count }, (_, i) => {
    const d = addDays(shop.today, i);
    const open = Boolean(shop.hours[dayKeyOf(d)]);
    const label = i === 0 ? "Today" : fmtDay(d, { weekday: "short" });
    return `<button type="button" class="day" aria-pressed="false" data-date="${d}" ${open ? "" : "disabled"} aria-label="${fmtDay(d, { weekday: "long", day: "numeric", month: "long" })}${open ? "" : ", closed"}">
      <small>${label}</small><b>${fmtDay(d, { day: "numeric" })}</b><small>${fmtDay(d, { month: "short" })}</small></button>`;
  }).join("");
  days.addEventListener("click", (e) => {
    const btn = e.target.closest(".day");
    if (!btn || btn.disabled) return;
    pressed(days, btn);
    state.date = btn.dataset.date;
    loadTimes();
  });

  $("#time-choices").addEventListener("click", (e) => {
    const btn = e.target.closest(".time");
    if (!btn) return;
    pressed($("#time-choices"), btn);
    state.time = btn.dataset.time;
    $("#step-details").disabled = false;
    updateSummary();
    $('#step-details input[name="name"]').focus({ preventScroll: false });
  });

  $("#booking").addEventListener("submit", submit);
  $("#book-another").addEventListener("click", () => location.reload());
}

async function loadTimes() {
  if (!state.service || !state.date) return;
  state.time = null;
  $("#step-details").disabled = true;
  updateSummary();
  const box = $("#time-choices");
  $("#step-time").disabled = false;
  box.innerHTML = `<p class="muted">Checking the diary…</p>`;
  const q = new URLSearchParams({ date: state.date, service: state.service.id, barber: state.barber });
  try {
    const res = await fetch(`/api/availability?${q}`);
    const data = await res.json();
    box.innerHTML = data.times?.length
      ? data.times.map((t) => `<button type="button" class="time" aria-pressed="false" data-time="${t}">${fmtTime(t)}</button>`).join("")
      : `<p class="muted">${esc(data.closedReason || "No free times that day.")} Try another day, or ring the shop.</p>`;
  } catch {
    box.innerHTML = `<p class="form-error">Couldn't load times. Check your connection and pick the day again.</p>`;
  }
}

function updateSummary() {
  const s = state.service;
  $("#summary").textContent = s && state.date && state.time
    ? `${s.name} on ${fmtDay(state.date, { weekday: "long", day: "numeric", month: "long" })} at ${fmtTime(state.time)}, ${price(s.price)}.`
    : "";
}

async function submit(e) {
  e.preventDefault();
  const form = e.target;
  const err = $("#form-error");
  err.textContent = "";
  const name = form.name.value.trim(), phone = form.phone.value.trim();
  if (!state.service || !state.date || !state.time) return (err.textContent = "Choose a service, a day and a time first.");
  if (!name) return (err.textContent = "Add your name so the barber knows who's in the chair.");
  if (phone.replace(/\D/g, "").length < 9) return (err.textContent = "Add a mobile number so we can text your confirmation.");

  const btn = $("#confirm");
  btn.disabled = true;
  btn.textContent = "Booking…";
  try {
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: state.service.id, barber: state.barber, date: state.date, time: state.time,
        name, phone, notes: form.notes.value, website: form.website.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      err.textContent = data.error || "That booking didn't go through. Try again or ring the shop.";
      if (res.status === 400 && /no longer free/.test(data.error || "")) loadTimes();
      return;
    }
    form.hidden = true;
    $("#booked-text").textContent = `${data.service} on ${data.day} at ${data.time}. ${price(data.price)}, pay in the shop. Your reference is ${data.reference}, and a text is on its way.`;
    $("#booked").hidden = false;
    $("#booked").focus();
  } catch {
    err.textContent = "That booking didn't go through. Check your connection and try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirm booking";
  }
}

const res = await fetch("/api/shop");
state.shop = await res.json();
renderShopDetails(state.shop);
renderGallery(state.shop);
renderBooking(state.shop);
