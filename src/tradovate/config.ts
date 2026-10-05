/**
 * Configuration for the Tradovate MCP server. Everything comes from the
 * environment so credentials never end up in the MCP client's tool calls.
 *
 * Safety model:
 *  - TRADOVATE_ENV defaults to "demo" (paper trading).
 *  - "live" is read-only unless TRADOVATE_LIVE_TRADING=1 is also set.
 *  - Every order is limited by quantity / position / daily-count limits and
 *    needs a preview → confirm round trip.
 */

export type TradovateEnv = "demo" | "live";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

function list(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export function loadConfig() {
  const envRaw = (process.env.TRADOVATE_ENV ?? "demo").toLowerCase();
  if (envRaw !== "demo" && envRaw !== "live") {
    throw new Error(`TRADOVATE_ENV must be "demo" or "live", got "${envRaw}"`);
  }
  const env = envRaw as TradovateEnv;

  return {
    env,
    baseUrl: process.env.TRADOVATE_BASE_URL ?? `https://${env}.tradovateapi.com/v1`,
    /** Orders are only allowed on demo, or on live with the explicit opt-in. */
    tradingEnabled: env === "demo" || process.env.TRADOVATE_LIVE_TRADING === "1",

    credentials: {
      name: process.env.TRADOVATE_USERNAME ?? "",
      password: process.env.TRADOVATE_PASSWORD ?? "",
      appId: process.env.TRADOVATE_APP_ID ?? "tradingview-mcp",
      appVersion: process.env.TRADOVATE_APP_VERSION ?? "1.0",
      cid: process.env.TRADOVATE_CID ?? "",
      sec: process.env.TRADOVATE_SEC ?? "",
      deviceId: process.env.TRADOVATE_DEVICE_ID ?? "tradingview-mcp",
    },
    /** Account name (e.g. "DEMO123456"); default: first account on the login. */
    account: process.env.TRADOVATE_ACCOUNT?.trim() || null,

    limits: {
      maxOrderQty: num("TRADOVATE_MAX_ORDER_QTY", 1),
      maxPosition: num("TRADOVATE_MAX_POSITION", 2),
      maxOrdersPerDay: num("TRADOVATE_MAX_ORDERS_PER_DAY", 20),
      /** Allowed products (root symbols like MES, MNQ). null = all. */
      allowedProducts: list("TRADOVATE_ALLOWED_PRODUCTS"),
    },
    confirmTtlMs: num("TRADOVATE_CONFIRM_TTL_SEC", 120) * 1000,
    journalFile: process.env.TRADOVATE_JOURNAL_FILE ?? ".tradovate_orders.jsonl",
  };
}

export type Config = ReturnType<typeof loadConfig>;
