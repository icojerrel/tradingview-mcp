#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { Trading } from "./safety.js";
import type { Broker } from "./broker.js";
import { PaperBroker } from "./brokers/paper.js";
import { AlpacaBroker } from "./brokers/alpaca.js";
import { TradovateBroker } from "./brokers/tradovate.js";

const config = loadConfig();
const broker: Broker =
  config.broker === "alpaca" ? new AlpacaBroker()
  : config.broker === "tradovate" ? new TradovateBroker()
  : new PaperBroker();
const trading = new Trading(config, broker);
const MODE = trading.modeLabel;

const SYMBOL_HELP: Record<string, string> = {
  paper: "TradingView symbol EXCHANGE:TICKER, e.g. NASDAQ:AAPL, BINANCE:BTCUSDT, CME_MINI:MES1!",
  alpaca: "Alpaca symbol, e.g. AAPL, SPY, BTC/USD",
  tradovate: "Full futures contract, e.g. MESZ6, MNQH7 (see trade_find_symbol)",
};

const server = new Server(
  { name: "trading-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ────────────────────────────────────────────────────────

const orderProperties = {
  symbol: { type: "string", description: SYMBOL_HELP[broker.name] },
  action: { type: "string", enum: ["Buy", "Sell"] },
  qty: { type: "number", exclusiveMinimum: 0 },
  orderType: { type: "string", enum: ["Market", "Limit", "Stop", "StopLimit"] },
  price: { type: "number", description: "Limit price (Limit, StopLimit)" },
  stopPrice: { type: "number", description: "Trigger price (Stop, StopLimit)" },
  timeInForce: { type: "string", enum: ["Day", "GTC"], description: "Default Day" },
  takeProfit: { type: "number", description: "Optional bracket: take-profit limit price" },
  stopLoss: { type: "number", description: "Optional bracket: stop-loss stop price" },
};

const tools = [
  {
    name: "trade_status",
    description: `Trading account status [${MODE}]: broker, mode, balance / P&L, risk limits, orders placed today`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "trade_positions",
    description: `List open positions [${MODE}]`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "trade_orders",
    description: `List working (open) orders [${MODE}]`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "trade_fills",
    description: `List fills (executions) [${MODE}]`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  ...(broker.findSymbols
    ? [{
      name: "trade_find_symbol",
      description: `Look up tradable symbols at ${broker.name}`,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }]
    : []),
  {
    name: "trade_preview_order",
    description:
      `Step 1 of 2 [${MODE}]: validate an order against the risk limits and return a summary plus a ` +
      "confirmation code. Sends NOTHING. Show the summary to the user and only confirm after they agree.",
    inputSchema: { type: "object", properties: orderProperties, required: ["symbol", "action", "qty", "orderType"] },
  },
  {
    name: "trade_confirm_order",
    description: `Step 2 of 2 [${MODE}]: place a previewed order using its confirmation code (single use, expires)`,
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "trade_cancel_order",
    description: `Cancel a working order by order id [${MODE}]`,
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "trade_close_position",
    description: `Flatten the open position in a symbol at market [${MODE}]`,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// ─── Tool handlers ───────────────────────────────────────────────────────────

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const orderZ = z.object({
  symbol: z.string().min(1),
  action: z.enum(["Buy", "Sell"]),
  qty: z.number().positive(),
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
      case "trade_status":
        return json(await trading.status());
      case "trade_positions":
        return json(await trading.positions());
      case "trade_orders":
        return json(await trading.workingOrders());
      case "trade_fills":
        return json(await trading.fills());
      case "trade_find_symbol": {
        const { text } = z.object({ text: z.string().min(1) }).parse(args);
        return json(await trading.findSymbols(text));
      }
      case "trade_preview_order":
        return json(await trading.preview(orderZ.parse(args)));
      case "trade_confirm_order": {
        const { code } = z.object({ code: z.string().min(1) }).parse(args);
        return json(await trading.confirm(code));
      }
      case "trade_cancel_order": {
        const { orderId } = z.object({ orderId: z.union([z.string(), z.number()]) }).parse(args);
        return json(await trading.cancel(String(orderId)));
      }
      case "trade_close_position": {
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
  console.error(`Trading MCP server running on stdio [${MODE}]`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
