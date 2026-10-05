#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import * as chart from "./chart.js";
import { connectionInfo, disconnect, getChartPage } from "./connection.js";

const ALLOW_EVAL = process.env.TV_APP_ALLOW_EVAL === "1";

const server = new Server(
  { name: "tradingview-app-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const SHAPE_HELP =
  "Shape name. One point: horizontal_line, vertical_line, text, arrow_up, arrow_down, flag, " +
  "horizontal_ray, note. Two points: trend_line, ray, extended, rectangle, circle, " +
  "fib_retracement, price_range, date_range, long_position, short_position. " +
  "Three points: triangle, parallel_channel, pitchfork.";

const pointSchema = {
  type: "object",
  properties: {
    time: { type: "number", description: "Unix timestamp in seconds (default: right edge of the visible range)" },
    price: { type: "number" },
  },
  required: ["price"],
};

// ─── Tool definitions ────────────────────────────────────────────────────────

const tools = [
  // ── Connection / state ────────────────────────────────────────────────────
  {
    name: "app_status",
    description: "Connect to the TradingView app and report the active chart (symbol, timeframe, chart type, indicators, drawings, visible range)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "app_reconnect",
    description: "Drop the current connection and reconnect to the TradingView app (use after restarting the app or switching tabs)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Chart ─────────────────────────────────────────────────────────────────
  {
    name: "chart_set_symbol",
    description: "Change the symbol of the active chart",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "EXCHANGE:TICKER, e.g. NASDAQ:AAPL, BINANCE:BTCUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "chart_set_timeframe",
    description: "Change the timeframe (resolution) of the active chart",
    inputSchema: {
      type: "object",
      properties: { timeframe: { type: "string", description: "e.g. 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M (or native: 60, 240, 1D)" } },
      required: ["timeframe"],
    },
  },
  {
    name: "chart_set_type",
    description: "Change the chart style (candles, bars, line, heikin_ashi, ...)",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", enum: Object.keys(chart.CHART_TYPES) } },
      required: ["type"],
    },
  },
  {
    name: "chart_set_visible_range",
    description: "Zoom/scroll the active chart to a time range",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "number", description: "Unix timestamp (seconds)" },
        to: { type: "number", description: "Unix timestamp (seconds)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "chart_execute_action",
    description: "Run a built-in chart action by id, e.g. chartReset, undo, redo, chartProperties, insertIndicator, timeScaleReset, lockUnlockAllDrawings, hideAllDrawings",
    inputSchema: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"],
    },
  },
  {
    name: "chart_get_bars",
    description: "Read the OHLCV bars currently loaded in the active chart",
    inputSchema: {
      type: "object",
      properties: { count: { type: "number", description: "Number of most recent bars (default 100, max 5000)" } },
      required: [],
    },
  },
  {
    name: "chart_screenshot",
    description: "Take a PNG screenshot of the active chart (or of the whole app window)",
    inputSchema: {
      type: "object",
      properties: { fullWindow: { type: "boolean", description: "Capture the whole window instead of only the chart (default false)" } },
      required: [],
    },
  },

  // ── Indicators ────────────────────────────────────────────────────────────
  {
    name: "indicator_add",
    description: "Add a built-in indicator to the active chart by its full name, e.g. 'Relative Strength Index', 'Moving Average Exponential', 'MACD', 'Bollinger Bands', 'Volume'",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        inputs: { type: "object", description: "Input values keyed by input id, e.g. { \"length\": 14 } (ids are shown by indicator_get)" },
        overrides: { type: "object", description: "Style overrides, e.g. { \"plot.color\": \"#ff0000\" }" },
        forceOverlay: { type: "boolean", description: "Draw on the price pane instead of a new pane" },
      },
      required: ["name"],
    },
  },
  {
    name: "indicator_get",
    description: "Get an indicator's current inputs and visibility",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "indicator_update",
    description: "Change an indicator's inputs and/or visibility",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        inputs: { type: "object", description: "Input values keyed by input id" },
        visible: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "indicator_remove",
    description: "Remove an indicator from the active chart",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },

  // ── Drawings ──────────────────────────────────────────────────────────────
  {
    name: "drawing_create",
    description: "Draw on the active chart: horizontal lines, trend lines, rectangles, text, fib retracements, long/short positions, ...",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", description: SHAPE_HELP },
        points: { type: "array", items: pointSchema, minItems: 1 },
        text: { type: "string", description: "Label text (for text/note shapes and lines with labels)" },
        overrides: { type: "object", description: "Style overrides, e.g. { \"linecolor\": \"#ff0000\", \"linewidth\": 2 }" },
        lock: { type: "boolean" },
      },
      required: ["shape", "points"],
    },
  },
  {
    name: "drawing_remove",
    description: "Remove drawings from the active chart. Without ids, removes ALL drawings.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: [],
    },
  },

  // ── Raw input ─────────────────────────────────────────────────────────────
  {
    name: "app_press_keys",
    description: "Send keyboard shortcuts to the app, pressed in order, e.g. [\"Alt+H\"] (horizontal line), [\"Control+S\"] (save layout), [\"Escape\"]",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["keys"],
    },
  },
  ...(ALLOW_EVAL
    ? [{
      name: "app_evaluate",
      description: "Run JavaScript inside the TradingView app (function body; use `return`). window.TradingViewApi is the chart API.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    }]
    : []),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// ─── Tool handlers ───────────────────────────────────────────────────────────

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const pointZ = z.object({ time: z.number().optional(), price: z.number() });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "app_status": {
        await getChartPage();
        return json({ connection: connectionInfo(), chart: await chart.getState() });
      }
      case "app_reconnect": {
        await disconnect();
        await getChartPage();
        return json({ connection: connectionInfo(), chart: await chart.getState() });
      }

      case "chart_set_symbol": {
        const { symbol } = z.object({ symbol: z.string().min(1) }).parse(args);
        return json(await chart.setSymbol(symbol));
      }
      case "chart_set_timeframe": {
        const { timeframe } = z.object({ timeframe: z.string().min(1) }).parse(args);
        return json(await chart.setResolution(timeframe));
      }
      case "chart_set_type": {
        const { type } = z.object({ type: z.string() }).parse(args);
        return json(await chart.setChartType(type));
      }
      case "chart_set_visible_range": {
        const { from, to } = z.object({ from: z.number(), to: z.number() }).parse(args);
        return json(await chart.setVisibleRange(from, to));
      }
      case "chart_execute_action": {
        const { actionId } = z.object({ actionId: z.string().min(1) }).parse(args);
        return json(await chart.executeAction(actionId));
      }
      case "chart_get_bars": {
        const { count } = z.object({ count: z.number().int().min(1).max(5000).optional() }).parse(args ?? {});
        return json(await chart.getVisibleBars(count ?? 100));
      }
      case "chart_screenshot": {
        const { fullWindow } = z.object({ fullWindow: z.boolean().optional() }).parse(args ?? {});
        const png = await chart.screenshot(fullWindow ?? false);
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }

      case "indicator_add": {
        const opts = z.object({
          name: z.string().min(1),
          inputs: z.record(z.unknown()).optional(),
          overrides: z.record(z.unknown()).optional(),
          forceOverlay: z.boolean().optional(),
        }).parse(args);
        return json(await chart.addIndicator(opts));
      }
      case "indicator_get": {
        const { id } = z.object({ id: z.string() }).parse(args);
        return json(await chart.getIndicator(id));
      }
      case "indicator_update": {
        const opts = z.object({
          id: z.string(),
          inputs: z.record(z.unknown()).optional(),
          visible: z.boolean().optional(),
        }).parse(args);
        return json(await chart.updateIndicator(opts));
      }
      case "indicator_remove": {
        const { id } = z.object({ id: z.string() }).parse(args);
        return json({ removed: id, indicators: await chart.removeIndicator(id) });
      }

      case "drawing_create": {
        const opts = z.object({
          shape: z.string().min(1),
          points: z.array(pointZ).min(1),
          text: z.string().optional(),
          overrides: z.record(z.unknown()).optional(),
          lock: z.boolean().optional(),
        }).parse(args);
        return json(await chart.drawShape(opts));
      }
      case "drawing_remove": {
        const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(args ?? {});
        return json({ drawings: await chart.removeDrawings(ids) });
      }

      case "app_press_keys": {
        const { keys } = z.object({ keys: z.array(z.string().min(1)).min(1) }).parse(args);
        await chart.pressKeys(keys);
        return json({ pressed: keys });
      }
      case "app_evaluate": {
        if (!ALLOW_EVAL) throw new Error("app_evaluate is disabled. Set TV_APP_ALLOW_EVAL=1 to enable it.");
        const { code } = z.object({ code: z.string() }).parse(args);
        return json(await chart.evaluate(code));
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
  console.error("TradingView app MCP server running on stdio");
}

const shutdown = () => { disconnect().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
