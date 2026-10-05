/**
 * Broker-independent configuration of the trading MCP server.
 *
 * TRADING_BROKER picks the broker: "paper" (default, built-in simulator on
 * TradingView prices), "alpaca" or "tradovate". Broker credentials are read
 * by each broker module.
 */

export type BrokerName = "paper" | "alpaca" | "tradovate";

export function num(name: string, fallback: number): number {
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
  const broker = (process.env.TRADING_BROKER ?? "paper").toLowerCase();
  if (!["paper", "alpaca", "tradovate"].includes(broker)) {
    throw new Error(`TRADING_BROKER must be paper, alpaca or tradovate, got "${broker}"`);
  }
  return {
    broker: broker as BrokerName,
    /** Opt-in for orders on a real-money account. */
    liveTradingOptIn: process.env.TRADING_LIVE_TRADING === "1",
    limits: {
      maxOrderQty: num("TRADING_MAX_ORDER_QTY", 1),
      maxPosition: num("TRADING_MAX_POSITION", 2),
      maxOrdersPerDay: num("TRADING_MAX_ORDERS_PER_DAY", 20),
      /** Allowed products (MES, AAPL, BTCUSDT, ...). null = all. */
      allowedProducts: list("TRADING_ALLOWED_PRODUCTS"),
    },
    confirmTtlMs: num("TRADING_CONFIRM_TTL_SEC", 120) * 1000,
    journalFile: process.env.TRADING_JOURNAL_FILE ?? ".trading_journal.jsonl",
  };
}

export type Config = ReturnType<typeof loadConfig>;
