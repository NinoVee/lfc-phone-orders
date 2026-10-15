// Pure order logic: menu lookup, validation, pricing, and hours.
// No network calls here, so it can be unit-tested directly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadMenu(file = path.join(__dirname, "..", "menu.json")) {
  const menu = JSON.parse(readFileSync(file, "utf8"));
  menu.byId = new Map(menu.items.map((i) => [i.id, i]));
  return menu;
}

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Match a caller's word ("lemon pepper", "mac and cheese") to a canonical option.
function matchOption(value, options) {
  const v = norm(value);
  if (!v) return null;
  return (
    options.find((o) => norm(o) === v) ||
    options.find((o) => norm(o).includes(v) || v.includes(norm(o))) ||
    null
  );
}

function findItem(menu, ref) {
  if (!ref) return null;
  if (menu.byId.has(ref)) return menu.byId.get(ref);
  const r = norm(ref);
  return menu.items.find((i) => norm(i.name) === r || norm(i.id) === r) || null;
}

const money = (n) => Math.round(n * 100) / 100;

// ---------- time helpers (restaurant-local) ----------
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function localNow(tz, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return {
    day: parts.weekday.toLowerCase().slice(0, 3),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const fmtTime = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
};

// Accepts "ASAP", "18:30", "6:30 pm", "6 PM".
export function parsePickupTime(input) {
  if (!input || /asap|now|soon|earliest/i.test(input)) return null;
  const m = String(input).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3]?.toLowerCase();
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  // No am/pm and a small hour: a restaurant pickup at "6:30" means evening.
  if (!ap && h >= 1 && h <= 9) h += 12;
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

export function hoursStatus(menu, date = new Date()) {
  const r = menu.restaurant;
  const { day, minutes } = localNow(r.timezone, date);
  const today = r.hours[day];
  if (!today) return { open: false, day, minutes, reason: "closed today" };
  const open = toMin(today[0]);
  const close = toMin(today[1]);
  const lastOrder = close - (r.last_order_minutes_before_close || 0);
  return {
    day,
    minutes,
    openAt: open,
    closeAt: close,
    lastOrder,
    open: minutes >= open && minutes < lastOrder,
    beforeOpen: minutes < open,
  };
}

function inLunch(menu, minutes) {
  const lh = menu.restaurant.lunch_menu_hours;
  if (!lh) return true; // not configured -> don't block
  return minutes >= toMin(lh[0]) && minutes < toMin(lh[1]);
}

// ---------- validation + pricing ----------
export function priceOrder(menu, items, opts = {}) {
  const problems = [];
  const needsStaff = [];
  const lines = [];
  let subtotal = 0;
  let pieceCount = 0;

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, problems: ["The order has no items yet."], lines, subtotal: 0 };
  }

  items.forEach((raw, idx) => {
    const label = `Item ${idx + 1}`;
    const item = findItem(menu, raw.item_id || raw.name);
    if (!item) {
      problems.push(`${label}: "${raw.item_id || raw.name}" is not on the menu. Ask the caller to pick something from the menu.`);
      return;
    }
    if (item.available === false) {
      problems.push(`${item.name} is out of stock right now. Offer something else.`);
      return;
    }
    if (item.lunch_only && opts.pickupMinutes != null && !inLunch(menu, opts.pickupMinutes)) {
      problems.push(`${item.name} is only on the lunch menu and isn't available at that pickup time.`);
      return;
    }

    const qty = Math.max(1, Math.min(50, parseInt(raw.quantity ?? 1, 10) || 1));
    const details = [];

    // Sides
    const wantSides = item.sides || 0;
    const wantLarge = item.large_sides || 0;
    const totalSides = wantSides + wantLarge;
    if (totalSides > 0) {
      const given = Array.isArray(raw.sides) ? raw.sides : raw.sides ? [raw.sides] : [];
      const matched = given.map((s) => matchOption(s, menu.side_choices));
      const bad = given.filter((_, i) => !matched[i]);
      if (bad.length) {
        problems.push(`${item.name}: "${bad.join(", ")}" isn't a side we offer. Sides are: ${menu.side_choices.join(", ")}.`);
      } else if (matched.length !== totalSides) {
        problems.push(
          `${item.name}: needs ${totalSides} ${wantLarge ? "large " : ""}side${totalSides > 1 ? "s" : ""} chosen` +
            ` (got ${matched.length}). Ask the caller which side${totalSides > 1 ? "s" : ""} they want.`
        );
      } else {
        details.push(`${wantLarge ? "Large side" : "Side"}${totalSides > 1 ? "s" : ""}: ${matched.join(", ")}`);
      }
    }

    if (item.fish_type) {
      const f = matchOption(raw.fish_type, menu.fish_types);
      if (!f) problems.push(`${item.name}: ask catfish or red snapper.`);
      else details.push(f);
    }
    if (item.wing_flavor) {
      const f = matchOption(raw.wing_flavor, menu.wing_flavors);
      if (!f) problems.push(`${item.name}: ask which flavor (${menu.wing_flavors.join(", ")}).`);
      else details.push(`Flavor: ${f}`);
    }
    if (item.oyster_doneness) {
      const d = matchOption(raw.oyster_doneness, menu.oyster_doneness);
      if (!d) problems.push(`${item.name}: ask how they'd like the oysters (${menu.oyster_doneness.join(", ")}).`);
      else details.push(`Oysters: ${d}`);
    }
    if (item.fish_po_boy_style) {
      const s = matchOption(raw.fry_style, menu.fish_po_boy_styles) || "Well Done";
      details.push(s);
    }
    if (item.choose_pieces) {
      const given = Array.isArray(raw.pieces) ? raw.pieces : [];
      const matched = given.map((p) => matchOption(p, item.choose_pieces.from));
      if (matched.length !== item.choose_pieces.count || matched.some((m) => !m)) {
        problems.push(`${item.name}: ask which ${item.choose_pieces.count} pieces (${item.choose_pieces.from.join(", ")}).`);
      } else details.push(`Pieces: ${matched.join(", ")}`);
    }
    if (raw.special_instructions) details.push(`Note: ${String(raw.special_instructions).slice(0, 140)}`);

    const lineTotal = money(item.price * qty);
    subtotal += lineTotal;
    const pcs = Number((item.name.match(/^(?:#\d+ )?(\d+) pc/) || [])[1] || 1);
    pieceCount += pcs * qty;
    lines.push({ item_id: item.id, name: item.name, quantity: qty, unit_price: item.price, line_total: lineTotal, details });
    if (item.notes && /extra charge|staff/i.test(item.notes)) needsStaff.push(`${item.name}: ${item.notes}`);
  });

  subtotal = money(subtotal);
  const feePct = menu.restaurant.card_fee_percent || 0;
  return {
    ok: problems.length === 0,
    problems,
    lines,
    subtotal,
    card_total: money(subtotal * (1 + feePct / 100)),
    piece_count: pieceCount,
    staff_notes: needsStaff,
  };
}

// Spoken summary the agent can read back almost verbatim.
export function speakableSummary(priced) {
  const parts = priced.lines.map((l) => {
    const d = l.details.length ? ` (${l.details.join("; ")})` : "";
    return `${l.quantity} ${l.name}${d}`;
  });
  return `${parts.join(", ")}. Subtotal $${priced.subtotal.toFixed(2)} before tax.`;
}
