// Webhook server for the Retell phone-ordering agent.
// Retell POSTs custom-tool calls here as { name, args, call }.
import express from "express";
import { Retell } from "retell-sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  loadMenu,
  priceOrder,
  speakableSummary,
  hoursStatus,
  parsePickupTime,
  fmtTime,
} from "./order.js";

const {
  PORT = 3000,
  RETELL_API_KEY,
  SKIP_SIGNATURE_CHECK, // "true" only for local testing
  ORDERS_FILE = "orders.jsonl",
  PREP_MINUTES = "20",
  LARGE_ORDER_PIECES = "24",
  LARGE_ORDER_EXTRA_MINUTES = "15",
  // Notifications (configure at least one so the kitchen sees orders)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  RESTAURANT_SMS_TO, // comma-separated, e.g. "+19095551234,+19095556789"
  TEXT_CUSTOMER_CONFIRMATION = "true",
  ORDER_WEBHOOK_URL, // optional: Zapier/Make/Slack/Google Sheets/printer bridge
} = process.env;

const menu = loadMenu();
const app = express();
app.use(express.raw({ type: "application/json", limit: "1mb" }));

// ---------- helpers ----------
async function verified(req) {
  if (SKIP_SIGNATURE_CHECK === "true") return true;
  const sig = req.headers["x-retell-signature"];
  if (!RETELL_API_KEY || typeof sig !== "string") return false;
  try {
    return Retell.verify(req.body.toString("utf8"), RETELL_API_KEY, sig);
  } catch {
    return false;
  }
}

function existingOrderForCall(callId) {
  if (!callId || !existsSync(ORDERS_FILE)) return null;
  const rows = readFileSync(ORDERS_FILE, "utf8").trim().split("\n").filter(Boolean);
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = JSON.parse(rows[i]);
    if (o.call_id === callId) return o;
  }
  return null;
}

const digits = (s) => String(s || "").replace(/\D/g, "");
function e164(s) {
  const d = digits(s);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return false;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
    }
  );
  if (!res.ok) console.error("Twilio error", res.status, await res.text());
  return res.ok;
}

function kitchenTicket(o) {
  const lines = o.lines
    .map((l) => `${l.quantity}x ${l.name}${l.details.length ? "\n   - " + l.details.join("\n   - ") : ""}`)
    .join("\n");
  return [
    `NEW PHONE ORDER #${o.order_number} (AI)`,
    `Pickup: ${o.pickup_label}`,
    `Name: ${o.customer_name}  Phone: ${o.callback_number}`,
    "",
    lines,
    "",
    `Subtotal: $${o.subtotal.toFixed(2)} + tax (pay at pickup)`,
    ...(o.staff_notes.length ? ["", "STAFF CHECK:", ...o.staff_notes] : []),
  ].join("\n");
}

// ---------- tool handlers ----------
const tools = {
  // Check hours / earliest pickup. Cheap, call at start of the call.
  check_hours() {
    const h = hoursStatus(menu);
    if (h.open) {
      return {
        open: true,
        message: `We're open. Last phone orders today are taken until ${fmtTime(h.lastOrder)}; we close at ${fmtTime(h.closeAt)}.`,
      };
    }
    if (h.beforeOpen && h.openAt != null) {
      return {
        open: false,
        can_preorder_today: true,
        message: `We open at ${fmtTime(h.openAt)} today. You can place an order now for pickup after we open.`,
      };
    }
    return { open: false, can_preorder_today: false, message: "We're closed for the day and not taking orders right now." };
  },

  // Price + validate without placing. Use for the read-back.
  price_order(args) {
    const priced = priceOrder(menu, args.items);
    if (!priced.ok) return { ok: false, fix_these: priced.problems };
    return {
      ok: true,
      readback: speakableSummary(priced),
      subtotal: priced.subtotal,
      if_paying_by_card: priced.card_total,
      staff_notes: priced.staff_notes,
    };
  },

  // Validate again, check hours, record, and notify the kitchen.
  async submit_order(args, call) {
    const dupe = existingOrderForCall(call?.call_id);
    if (dupe) {
      return { ok: true, already_submitted: true, order_number: dupe.order_number, ready_at: dupe.pickup_label };
    }

    if (!args.customer_name || String(args.customer_name).trim().length < 2) {
      return { ok: false, fix_these: ["Ask for the name for the order."] };
    }
    const callback = e164(args.callback_number) || e164(call?.from_number);
    if (!callback) return { ok: false, fix_these: ["Ask for a 10-digit callback number."] };

    const h = hoursStatus(menu);
    const requested = parsePickupTime(args.pickup_time);
    if (requested === undefined) {
      return { ok: false, fix_these: [`Couldn't understand pickup time "${args.pickup_time}". Ask for ASAP or a clock time.`] };
    }
    if (!h.open && !h.beforeOpen) {
      return { ok: false, closed: true, fix_these: ["The restaurant is closed for the day. Don't place the order; tell the caller our hours."] };
    }

    const priced = priceOrder(menu, args.items, { pickupMinutes: requested ?? h.minutes });
    if (!priced.ok) return { ok: false, fix_these: priced.problems };

    const prep =
      Number(PREP_MINUTES) + (priced.piece_count >= Number(LARGE_ORDER_PIECES) ? Number(LARGE_ORDER_EXTRA_MINUTES) : 0);
    const earliest = Math.max(h.minutes, h.openAt ?? 0) + prep;

    let readyAt;
    if (requested == null) readyAt = earliest;
    else if (requested < earliest) {
      return { ok: false, fix_these: [`The earliest pickup is about ${fmtTime(earliest)}. Ask if that works.`] };
    } else if (requested > h.closeAt - 5) {
      return { ok: false, fix_these: [`We close at ${fmtTime(h.closeAt)}. Pickup must be before then.`] };
    } else readyAt = requested;

    const order = {
      order_number: String(Math.floor(100 + Math.random() * 900)),
      created_at: new Date().toISOString(),
      call_id: call?.call_id || null,
      customer_name: String(args.customer_name).trim().slice(0, 60),
      callback_number: callback,
      pickup_label: requested == null ? `ASAP, about ${fmtTime(readyAt)}` : fmtTime(readyAt),
      lines: priced.lines,
      subtotal: priced.subtotal,
      staff_notes: priced.staff_notes,
      order_notes: args.order_notes || "",
    };
    if (order.order_notes) order.staff_notes = [...order.staff_notes, `Order note: ${order.order_notes}`];

    // Notify. At least one channel must succeed or the kitchen never sees it.
    const ticket = kitchenTicket(order);
    const results = [];
    for (const to of (RESTAURANT_SMS_TO || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      results.push(await sendSms(to, ticket).catch(() => false));
    }
    if (ORDER_WEBHOOK_URL) {
      results.push(
        await fetch(ORDER_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...order, ticket_text: ticket }),
        })
          .then((r) => r.ok)
          .catch(() => false)
      );
    }
    const delivered = results.some(Boolean);
    if (!delivered && SKIP_SIGNATURE_CHECK !== "true") {
      console.error("Order not delivered to restaurant", order);
      return { ok: false, delivery_failed: true, fix_these: ["Our order system is down. Transfer the caller to staff."] };
    }

    appendFileSync(ORDERS_FILE, JSON.stringify(order) + "\n");
    console.log(ticket);

    if (TEXT_CUSTOMER_CONFIRMATION === "true") {
      sendSms(
        callback,
        `${menu.restaurant.name}: order #${order.order_number} for ${order.customer_name} will be ready ${order.pickup_label}. ` +
          `Subtotal $${order.subtotal.toFixed(2)} + tax, pay at pickup. ${menu.restaurant.address}`
      ).catch(() => {});
    }

    return {
      ok: true,
      order_number: order.order_number,
      ready_at: order.pickup_label,
      subtotal: order.subtotal,
      say: `Order number ${order.order_number.split("").join(" ")}, ready ${order.pickup_label}.`,
    };
  },
};

// One endpoint per tool keeps Retell's tool URLs simple: /tools/<name>
app.post("/tools/:name", async (req, res) => {
  if (!(await verified(req))) return res.status(401).json({ error: "bad signature" });
  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid json" });
  }
  const fn = tools[req.params.name];
  if (!fn) return res.status(404).json({ error: "unknown tool" });
  try {
    res.json(await fn(body.args || {}, body.call || {}));
  } catch (err) {
    console.error(err);
    res.json({ ok: false, fix_these: ["Something went wrong on our end. Transfer the caller to staff."] });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, items: menu.items.length }));

app.listen(PORT, () => console.log(`Order webhook listening on :${PORT}`));
