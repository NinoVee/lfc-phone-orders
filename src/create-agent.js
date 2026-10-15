// Creates (or updates) the Retell LLM + voice agent.
// Usage:
//   RETELL_API_KEY=... WEBHOOK_BASE_URL=https://your-app.example.com \
//   STAFF_TRANSFER_NUMBER=+1909XXXXXXX node src/create-agent.js
// Re-run with LLM_ID=... AGENT_ID=... to push prompt/menu changes to the same agent.
import Retell from "retell-sdk";
import { buildPrompt } from "./build-prompt.js";

const {
  RETELL_API_KEY,
  WEBHOOK_BASE_URL,
  STAFF_TRANSFER_NUMBER,
  RETELL_MODEL = "gpt-4.1",
  RETELL_VOICE_ID = "11labs-Adrian",
  LLM_ID,
  AGENT_ID,
} = process.env;

for (const [k, v] of Object.entries({ RETELL_API_KEY, WEBHOOK_BASE_URL, STAFF_TRANSFER_NUMBER })) {
  if (!v) {
    console.error(`Missing ${k}. See README.`);
    process.exit(1);
  }
}

const base = WEBHOOK_BASE_URL.replace(/\/$/, "");

const orderItem = {
  type: "object",
  properties: {
    item_id: { type: "string", description: "The [item_id] from the MENU, e.g. box_8" },
    quantity: { type: "integer", minimum: 1 },
    sides: { type: "array", items: { type: "string" }, description: "Side choices, one entry per side included" },
    fish_type: { type: "string", enum: ["Catfish", "Red Snapper"] },
    oyster_doneness: { type: "string", enum: ["Well Done", "Medium", "Medium Rare", "Rare"] },
    fry_style: { type: "string", enum: ["Well Done", "Lightly Fried"], description: "Fish Po' Boy only" },
    wing_flavor: { type: "string", enum: ["Sweet & Sassy", "Lemon Pepper", "Cajun Rub", "BBQ", "Hot Buffalo"] },
    pieces: { type: "array", items: { type: "string", enum: ["Thigh", "Leg", "Wing"] }, description: "2 pc Chicken Pack only" },
    special_instructions: { type: "string", description: "Short note, e.g. extra crispy, sauce on the side" },
  },
  required: ["item_id", "quantity"],
};

const general_tools = [
  {
    type: "custom",
    name: "check_hours",
    description: "Check whether the restaurant is open and taking phone orders right now.",
    url: `${base}/tools/check_hours`,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: { type: "object", properties: {} },
  },
  {
    type: "custom",
    name: "price_order",
    description: "Validate the order and get the subtotal plus a readback sentence. Does NOT place the order.",
    url: `${base}/tools/price_order`,
    speak_during_execution: true,
    execution_message_description: "Let me add that up for you.",
    speak_after_execution: true,
    parameters: {
      type: "object",
      properties: { items: { type: "array", items: orderItem } },
      required: ["items"],
    },
  },
  {
    type: "custom",
    name: "submit_order",
    description: "Place the confirmed pickup order and send it to the kitchen. Call once, only after the caller confirms the readback.",
    url: `${base}/tools/submit_order`,
    speak_during_execution: true,
    execution_message_description: "Okay, putting that order in now.",
    speak_after_execution: true,
    parameters: {
      type: "object",
      properties: {
        items: { type: "array", items: orderItem },
        customer_name: { type: "string" },
        callback_number: { type: "string", description: "10-digit number; use {{user_number}} if the caller confirmed it" },
        pickup_time: { type: "string", description: "ASAP, or a time today like 6:30 PM" },
        order_notes: { type: "string" },
      },
      required: ["items", "customer_name", "callback_number", "pickup_time"],
    },
  },
  {
    type: "transfer_call",
    name: "transfer_to_staff",
    description:
      "Transfer to a staff member for catering, complaints, changes after submitting, questions you can't answer, system errors, or when the caller asks for a person.",
    transfer_destination: { type: "predefined", number: STAFF_TRANSFER_NUMBER },
    transfer_option: { type: "cold_transfer", show_transferee_as_caller: true },
  },
  {
    type: "end_call",
    name: "end_call",
    description: "Hang up after the order is confirmed and you've said goodbye, or the caller is done.",
  },
];

const llmConfig = {
  model: RETELL_MODEL,
  general_prompt: buildPrompt(),
  begin_message:
    "Thanks for calling Louisiana Fried Chicken and Seafood in Fontana! I'm the restaurant's automated ordering assistant, and this call may be recorded. What can I get started for you today?",
  general_tools,
};

const retell = new Retell({ apiKey: RETELL_API_KEY });

const llm = LLM_ID ? await retell.llm.update(LLM_ID, llmConfig) : await retell.llm.create(llmConfig);
console.log(`${LLM_ID ? "Updated" : "Created"} Retell LLM: ${llm.llm_id}`);

const agentConfig = {
  agent_name: "LFC Fontana – Phone Orders",
  response_engine: { type: "retell-llm", llm_id: llm.llm_id },
  voice_id: RETELL_VOICE_ID,
  language: "en-US",
};
const agent = AGENT_ID ? await retell.agent.update(AGENT_ID, agentConfig) : await retell.agent.create(agentConfig);
console.log(`${AGENT_ID ? "Updated" : "Created"} agent: ${agent.agent_id}`);
console.log("\nNext: in the Retell dashboard, buy or import a phone number and set this agent as its inbound agent.");
