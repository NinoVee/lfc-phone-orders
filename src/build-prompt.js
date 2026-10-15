// Renders prompt.md with the menu from menu.json, so prices live in one place.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMenu } from "./order.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function renderMenu(menu = loadMenu()) {
  const byCat = new Map();
  for (const i of menu.items) {
    if (!byCat.has(i.category)) byCat.set(i.category, []);
    byCat.get(i.category).push(i);
  }
  const out = [];
  for (const [cat, items] of byCat) {
    out.push(`### ${cat}`);
    for (const i of items) {
      const tags = [];
      if (i.available === false) tags.push("OUT OF STOCK");
      if (i.includes) tags.push(i.includes);
      if (i.sides) tags.push(`choose ${i.sides} side`);
      if (i.large_sides) tags.push(`choose ${i.large_sides} large side${i.large_sides > 1 ? "s" : ""}`);
      if (i.fish_type) tags.push("ask fish type");
      if (i.oyster_doneness) tags.push("ask oyster doneness");
      if (i.wing_flavor) tags.push("ask flavor");
      if (i.fish_po_boy_style) tags.push("well done or lightly fried");
      if (i.notes && i.available !== false) tags.push(i.notes);
      out.push(`- ${i.name} [${i.id}] $${i.price.toFixed(2)}${tags.length ? " — " + tags.join("; ") : ""}`);
    }
    out.push("");
  }
  out.push(`Side choices: ${menu.side_choices.join(", ")}.`);
  out.push(`Wing flavors: ${menu.wing_flavors.join(", ")}.`);
  out.push(`Hours: Mon–Thu 11:30am–8pm, Fri–Sat 11:30am–9pm, Sun 11:30am–5pm.`);
  out.push(menu.catering_note);
  return out.join("\n");
}

export function buildPrompt() {
  return readFileSync(path.join(root, "prompt.md"), "utf8").replace("<<MENU>>", renderMenu());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(buildPrompt());
}
