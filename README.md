# Louisiana Fried Chicken & Seafood: AI phone ordering (Retell)

An inbound Retell voice agent that takes **pickup** orders for the Fontana location (16951 Foothill Blvd, Suite B). Callers order by voice. The agent validates every choice against the real menu, reads back the subtotal, and texts the order ticket to the kitchen. The caller gets a confirmation text.

```
Caller ──► Retell number ──► Retell agent (prompt + menu)
                                  │  tool calls
                                  ▼
                         Your webhook (src/server.js)
                           ├─ check_hours
                           ├─ price_order   (validate + subtotal, nothing placed)
                           └─ submit_order  (hours check, order #, ready time)
                                  │
                ┌─────────────────┼──────────────────┐
         SMS to kitchen     SMS to customer    optional webhook
         (Twilio)           (confirmation)     (Zapier/Sheets/Slack/printer)
```

## Files

| File | What it is |
|---|---|
| `menu.json` | Single source of truth: prices, item rules, sides, flavors, hours. Edit this to change the menu. |
| `prompt.md` | Agent instructions. The menu is injected at `<<MENU>>` when you deploy. |
| `src/order.js` | Validation and pricing. Catches missing sides, fish type, oyster doneness, wing flavor, out-of-stock items, and closed hours. |
| `src/server.js` | Webhook Retell calls during the conversation (`/tools/<name>`). Verifies Retell's signature. |
| `src/create-agent.js` | Creates or updates the Retell LLM and agent via API, with all 5 tools wired up. |
| `test/` | Unit tests (`npm test`). |

## Setup (about 30 minutes)

1. **Deploy the webhook.** Any Node 18+ host works: Render, Railway, Fly.io, or a VPS.
   ```bash
   npm install
   npm start
   ```
   Set these environment variables on the host:
   | Var | Required | Example |
   |---|---|---|
   | `RETELL_API_KEY` | yes | from Retell dashboard → API Keys (used to verify requests) |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | for SMS | Twilio console |
   | `RESTAURANT_SMS_TO` | yes* | `+19095551234,+19095556789` (kitchen/manager cells) |
   | `ORDER_WEBHOOK_URL` | optional* | Zapier/Make catch hook, to log to Google Sheets, Slack, a ticket printer, etc. |
   | `TEXT_CUSTOMER_CONFIRMATION` | optional | `true` (default) |
   | `PREP_MINUTES` | optional | `20` (default); +15 when the order has 24+ pieces |

   \*At least one of `RESTAURANT_SMS_TO` or `ORDER_WEBHOOK_URL` must work. If neither delivers, the agent tells the caller and transfers to staff rather than taking an order nobody sees.

   **Note:** `orders.jsonl` is written to local disk. On hosts with temporary disks (Render free tier, etc.), use `ORDER_WEBHOOK_URL` to a Google Sheet so you keep a permanent record.

2. **Create the agent.**
   ```bash
   RETELL_API_KEY=key_xxx \
   WEBHOOK_BASE_URL=https://your-host.example.com \
   STAFF_TRANSFER_NUMBER=+1909XXXXXXX \
   npm run create-agent
   ```
   Optional: `RETELL_MODEL` (default `gpt-4.1`; the SDK also accepts `gpt-5`, `claude-4.5-sonnet`, etc.) and `RETELL_VOICE_ID` (default `11labs-Adrian`; pick any voice in the dashboard).
   It prints `llm_id` and `agent_id`. Save them. After editing `menu.json` or `prompt.md`, push the changes to the same agent:
   ```bash
   LLM_ID=llm_xxx AGENT_ID=agent_xxx ... npm run create-agent
   ```

3. **Test in the browser first.** In the Retell dashboard, open the agent → **Test** and place a few orders. Try:
   - a combo with no side
   - oysters with no doneness
   - jambalaya (out of stock)
   - a 50 pc catering tray (should transfer)
   - "pickup at 9:30 tonight" on a weeknight (past close)

4. **Get a number.** Retell dashboard → Phone Numbers → buy a 909 number (or import one) → set **Inbound agent** to this agent.

5. **Route the restaurant's calls.** Choose one:
   - **Overflow (recommended to start):** set the restaurant line (909-275-3360) to *forward when busy or no answer* to the Retell number. Staff still pick up when they can, and the AI catches the rest during rushes.
   - **AI first:** forward all calls unconditionally.

   ⚠️ **`STAFF_TRANSFER_NUMBER` must NOT be the main restaurant line if you forward all calls.** The transfer would ring back into the AI and loop. Use a manager's cell or a separate back line.

## Questions for the owner before going live

These were not on the website or Toast, so the agent plays them safe for now:

1. **Large side upcharge:** Toast lists sides as "$4.25+". The agent only sells regular-size à la carte sides. What does a large cost?
2. **Red snapper vs. catfish:** is snapper the same price? Currently priced the same.
3. **Gumbo + 5 shrimp:** what's the add-on price? Currently noted on the ticket as "STAFF CHECK" for staff to add at pickup.
4. **Lunch menu hours:** what times? Set `lunch_menu_hours` in `menu.json` (e.g. `["11:30","15:00"]`). Until then lunch items aren't time-restricted.
5. **Combo sides:** can every side be chosen as the combo side, or are some (e.g. gumbo, dirty rice) extra?
6. **Hours:** the website says Mon–Thu 11:30–8, Fri–Sat 11:30–9, Sun 11:30–5. Toast's online hours look misconfigured (it showed "closes 3:59 AM"). Confirm the website hours.
7. **Out of stock:** Jambalaya was marked out of stock on Toast on Oct 15, 2026, so it's set `"available": false`. Flip it when it's back and re-run `create-agent`.
8. **Sales tax:** the agent quotes subtotal "plus tax" and payment happens at pickup. Want it to quote an exact total instead? If so, provide the rate.

## Compliance notes

- **Recording:** California requires all-party consent to record. The greeting says the call may be recorded. Keep that line, or turn recording off in the Retell agent's data storage settings.
- **AI disclosure:** the greeting says it's an automated assistant, and the prompt has it confirm if asked.
- **No payment by phone:** the agent never takes card numbers, which keeps PCI out of scope.

## Nice next step: Toast integration

Right now orders arrive as a text or ticket that staff key into Toast. Toast's Orders API can inject orders straight into the POS and kitchen display, but it requires Toast partner/API access. If the owner can get that, `submit_order` is the one place to add it.
