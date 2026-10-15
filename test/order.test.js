import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMenu, priceOrder, parsePickupTime, hoursStatus, speakableSummary } from "../src/order.js";

const menu = loadMenu();

test("prices a typical family order", () => {
  const r = priceOrder(menu, [
    { item_id: "box_8", quantity: 1, sides: ["mac and cheese"] },
    { item_id: "fish_plate", quantity: 2, sides: ["fries"], fish_type: "catfish" },
    { item_id: "flavor_wings_10", quantity: 1, wing_flavor: "lemon pepper" },
    { item_id: "drink_sweet_tea", quantity: 2 },
  ]);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.subtotal, 83.54); // 26.99 + 2*15.99 + 18.99 + 2*2.79
  assert.match(speakableSummary(r), /Mac & Cheese/);
});

test("flags missing choices", () => {
  const r = priceOrder(menu, [
    { item_id: "seafood_family_box", quantity: 1, sides: ["yams"] },
    { item_id: "oyster_plate", quantity: 1, sides: ["rice"] },
    { item_id: "flavor_wings_5", quantity: 1 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 4); // 2 large sides needed, fish type, oyster doneness, flavor
});

test("rejects unknown and out-of-stock items", () => {
  const r = priceOrder(menu, [{ item_id: "lobster_tail", quantity: 1 }, { item_id: "jambalaya", quantity: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
});

test("accepts item names as a fallback", () => {
  const r = priceOrder(menu, [{ name: "Shrimp Po' Boy", quantity: 1 }]);
  assert.equal(r.ok, true);
});

test("parses pickup times", () => {
  assert.equal(parsePickupTime("ASAP"), null);
  assert.equal(parsePickupTime("6:30 PM"), 18 * 60 + 30);
  assert.equal(parsePickupTime("6:30"), 18 * 60 + 30);
  assert.equal(parsePickupTime("11:45 am"), 11 * 60 + 45);
  assert.equal(parsePickupTime("whenever"), undefined);
});

test("hours: Sunday 4:50pm is past last call, Friday 8:30pm is open", () => {
  // 2026-10-18 is a Sunday; 23:50 UTC = 4:50 PM PDT
  assert.equal(hoursStatus(menu, new Date("2026-10-18T23:50:00Z")).open, false);
  // 2026-10-16 Friday, 03:30 UTC next day = 8:30 PM PDT
  assert.equal(hoursStatus(menu, new Date("2026-10-17T03:30:00Z")).open, true);
  // Thursday 10am PDT: before open, can preorder
  const early = hoursStatus(menu, new Date("2026-10-15T17:00:00Z"));
  assert.equal(early.open, false);
  assert.equal(early.beforeOpen, true);
});
