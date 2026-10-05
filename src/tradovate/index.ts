#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { Trading } from "./trading.js";

const config = loadConfig();
const trading = new Trading(config);
const ENV_LABEL = config.env === "demo" ? "DEMO/paper" : config.tradingEnabled ? "LIVE" : "LIVE (read-only)";

const server = new Server(
  { name: "tradovate-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ────────────────────────────────────────────────────────

const orderProperties = {
  symbol: { type: "string", description: "Full contract name, e.g. MESZ6, MNQH7 (see tradovate_find_contract)" },
  action: { type: "string", enum: ["Buy", "Sell"] },
  qty: { type: "integer", minimum: 1 },
  orderType: { type: "string", enum: ["Market", "Limit", "Stop", "StopLimit"] },
  price: { type: "number", description: "Limit price (Limit, StopLimit)" },
  stopPrice: { type: "number", description: "Trigger price (Stop, StopLimit)" },
  timeInForce: { type: "string", enum: ["Day", "GTC"], description: "Default Day" },
  takeProfit: { type: "number", description: "Optional bracket: take-profit limit price" },
  stopLoss: { type: "number", description: "Optional bracket: stop-loss stop price" },
};

const tools = [
  {
    name: "tradovate_status",
    description: `Tradovate account status [${ENV_LABEL}]: environment, account, cash balance / P&L, risk limits, orders placed today`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tradovate_positions",
    description: "List open positions",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tradovate_orders",
    description: "List working (open) orders",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tradovate_fills",
    description: "List fills (executions) of this session",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "tradovate_find_contract",
    description: "Find futures contracts by text, e.g. 'MES' → MESZ6, MESH7",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "tradovate_preview_order",
    description:
      `Step 1 of 2 [${ENV_LABEL}]: validate an order against the risk limits and return a summary plus a ` +
      "confirmation code. Sends NOTHING to the exchange. Show the summary to the user and only confirm after they agree.",
    inputSchema: { type: "object", properties: orderProperties, required: ["symbol", "action", "qty", "orderType"] },
  },
  {
    name: "tradovate_confirm_order",
    description: `Step 2 of 2 [${ENV_LABEL}]: place a previewed order using its confirmation code (single use, expires)`,
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "tradovate_cancel_order",
    description: "Cancel a working order by order id",
    inputSchema: { type: "object", properties: { orderId: { type: "integer" } }, required: ["orderId"] },
  },
  {
    name: "tradovate_close_position",
    description: `Flatten the open position in a contract at market [${ENV_LABEL}]`,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// ─── Tool handlers ───────────────────────────────────────────────────────────

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const orderZ = z.object({
  symbol: z.string().min(1),
  action: z.enum(["Buy", "Sell"]),
  qty: z.number().int().min(1),
  orderType: z.enum(["Market", "Limit", "Stop", "StopLimit"]),
  price: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  timeInForce: z.enum(["Day", "GTC"]).optional(),
  takeProfit: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "tradovate_status":
        return json(await trading.status());
      case "tradovate_positions":
        return json(await trading.positions());
      case "tradovate_orders":
        return json(await trading.workingOrders());
      case "tradovate_fills":
        return json(await trading.fills());
      case "tradovate_find_contract": {
        const { text } = z.object({ text: z.string().min(1) }).parse(args);
        return json(await trading.findContracts(text));
      }
      case "tradovate_preview_order":
        return json(await trading.preview(orderZ.parse(args)));
      case "tradovate_confirm_order": {
        const { code } = z.object({ code: z.string().min(1) }).parse(args);
        return json(await trading.confirm(code));
      }
      case "tradovate_cancel_order": {
        const { orderId } = z.object({ orderId: z.number().int() }).parse(args);
        return json(await trading.cancel(orderId));
      }
      case "tradovate_close_position": {
        const { symbol } = z.object({ symbol: z.string().min(1) }).parse(args);
        return json(await trading.closePosition(symbol));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Tradovate MCP server running on stdio [${ENV_LABEL}]`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
