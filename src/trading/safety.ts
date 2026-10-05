import { randomInt } from "crypto";
import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import type { Config } from "./config.js";
import { BrokerRejection, type Broker, type Instrument, type OrderRequest } from "./broker.js";

/**
 * Safety layer between the MCP tools and a broker:
 *  - orders on a live account are refused unless TRADING_LIVE_TRADING=1
 *  - every order is a preview → confirm round trip with a single-use code
 *  - quantity / position / daily-count / product limits, checked at preview
 *    and again at confirm
 *  - every order-related action is appended to a JSONL journal
 */

interface Pending { order: OrderRequest; instrument: Instrument; expiresAt: number }

export class Trading {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly config: Config, readonly broker: Broker) {}

  get tradingEnabled(): boolean {
    return !this.broker.isLive || this.config.liveTradingOptIn;
  }

  get modeLabel(): string {
    const b = this.broker.name;
    if (b === "paper") return "PAPER (simulated)";
    if (!this.broker.isLive) return `${b} PAPER`;
    return this.tradingEnabled ? `${b} LIVE` : `${b} LIVE (read-only)`;
  }

  // ─── Read-only ──────────────────────────────────────────────────────────────

  async status() {
    const acc = await this.broker.account();
    return {
      broker: this.broker.name,
      mode: this.modeLabel,
      tradingEnabled: this.tradingEnabled,
      account: acc.account,
      balance: acc.balance,
      limits: this.config.limits,
      ordersPlacedToday: await this.ordersPlacedToday(),
    };
  }

  positions() { return this.broker.positions(); }
  workingOrders() { return this.broker.workingOrders(); }
  fills() { return this.broker.fills(); }

  async findSymbols(text: string) {
    if (!this.broker.findSymbols) throw new Error(`Symbol search is not supported for ${this.broker.name}`);
    return this.broker.findSymbols(text);
  }

  // ─── Orders: preview → confirm ──────────────────────────────────────────────

  async preview(order: OrderRequest) {
    this.assertTradingEnabled();
    validateShape(order);
    const instrument = await this.broker.resolve(order.symbol);
    this.broker.validate?.(order, instrument);
    const position = await this.checkLimits(order, instrument);

    this.prunePending();
    const code = String(randomInt(100000, 1000000));
    this.pending.set(code, { order, instrument, expiresAt: Date.now() + this.config.confirmTtlMs });

    return {
      confirmationCode: code,
      expiresInSeconds: Math.round(this.config.confirmTtlMs / 1000),
      mode: this.modeLabel,
      summary: describe(order, instrument.symbol),
      order: { ...order, symbol: instrument.symbol },
      currentPosition: position.current,
      positionAfterFill: position.after,
      note: "Nothing has been sent yet. Call trade_confirm_order with this code to place it.",
    };
  }

  async confirm(code: string) {
    this.assertTradingEnabled();
    this.prunePending();
    const p = this.pending.get(code);
    if (!p) throw new Error("Unknown or expired confirmation code. Preview the order again.");
    this.pending.delete(code); // single use, also when the order fails below

    await this.checkLimits(p.order, p.instrument);

    const request = { ...p.order, symbol: p.instrument.symbol };
    let result;
    try {
      result = await this.broker.place(p.order, p.instrument);
    } catch (err) {
      if (err instanceof BrokerRejection) {
        await this.journal("rejected", request, err.raw);
        throw new Error(`Order rejected: ${err.message}`);
      }
      throw err;
    }
    await this.journal("placed", request, result.raw ?? result);
    const { raw: _raw, ...visible } = result;
    return { placed: true, mode: this.modeLabel, ...visible, summary: describe(p.order, p.instrument.symbol) };
  }

  async cancel(orderId: string) {
    this.assertTradingEnabled();
    try {
      await this.broker.cancel(orderId);
    } catch (err) {
      if (err instanceof BrokerRejection) throw new Error(`Cancel failed: ${err.message}`);
      throw err;
    }
    await this.journal("cancelled", { orderId }, null);
    return { cancelled: orderId };
  }

  async closePosition(symbol: string) {
    this.assertTradingEnabled();
    const instrument = await this.broker.resolve(symbol);
    const res = await this.broker.close(instrument);
    await this.journal("closed", { symbol: instrument.symbol, previousQty: res.previousQty }, res);
    return { closed: instrument.symbol, ...res };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private assertTradingEnabled() {
    if (!this.tradingEnabled) {
      throw new Error(
        `Trading is disabled: ${this.broker.name} is connected to a LIVE account, which is read-only unless TRADING_LIVE_TRADING=1 is set.`
      );
    }
  }

  private async checkLimits(order: OrderRequest, instrument: Instrument) {
    const { maxOrderQty, maxPosition, maxOrdersPerDay, allowedProducts } = this.config.limits;

    if (allowedProducts && !allowedProducts.includes(instrument.product.toUpperCase())) {
      throw new Error(`Product ${instrument.product} is not allowed (TRADING_ALLOWED_PRODUCTS=${allowedProducts.join(",")})`);
    }
    if (order.qty > maxOrderQty) {
      throw new Error(`Quantity ${order.qty} exceeds the per-order limit of ${maxOrderQty} (TRADING_MAX_ORDER_QTY)`);
    }
    const today = await this.ordersPlacedToday();
    if (today >= maxOrdersPerDay) {
      throw new Error(`Daily order limit reached (${today}/${maxOrdersPerDay}, TRADING_MAX_ORDERS_PER_DAY)`);
    }

    const positions = await this.broker.positions();
    const current = positions.find((p) => p.symbol === instrument.symbol)?.qty ?? 0;
    const after = round(current + (order.action === "Buy" ? order.qty : -order.qty));
    // Orders that shrink the position are always allowed.
    if (Math.abs(after) > maxPosition && Math.abs(after) > Math.abs(current)) {
      throw new Error(
        `Position in ${instrument.symbol} would become ${after}, above the limit of ±${maxPosition} (TRADING_MAX_POSITION)`
      );
    }
    return { current, after };
  }

  private prunePending() {
    const now = Date.now();
    for (const [code, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(code);
  }

  private async ordersPlacedToday(): Promise<number> {
    if (!existsSync(this.config.journalFile)) return 0;
    const day = new Date().toISOString().slice(0, 10);
    const lines = (await readFile(this.config.journalFile, "utf-8")).split("\n");
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === "placed" && e.mode === this.modeLabel && String(e.ts).startsWith(day)) count++;
      } catch { /* skip corrupt line */ }
    }
    return count;
  }

  private async journal(event: string, request: unknown, response: unknown) {
    const entry = { ts: new Date().toISOString(), mode: this.modeLabel, event, request, response };
    await appendFile(this.config.journalFile, JSON.stringify(entry) + "\n");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const round = (n: number) => Math.round(n * 1e8) / 1e8;

function validateShape(o: OrderRequest) {
  if (!(o.qty > 0)) throw new Error("qty must be positive");
  const needPrice = o.orderType === "Limit" || o.orderType === "StopLimit";
  const needStop = o.orderType === "Stop" || o.orderType === "StopLimit";
  if (needPrice && o.price === undefined) throw new Error(`${o.orderType} orders need a price`);
  if (needStop && o.stopPrice === undefined) throw new Error(`${o.orderType} orders need a stopPrice`);
  if (!needPrice && o.price !== undefined) throw new Error(`${o.orderType} orders take no price`);
  if (!needStop && o.stopPrice !== undefined) throw new Error(`${o.orderType} orders take no stopPrice`);

  const { takeProfit: tp, stopLoss: sl } = o;
  const long = o.action === "Buy";
  if (tp !== undefined && sl !== undefined && (long ? tp <= sl : tp >= sl)) {
    throw new Error(long
      ? `For a Buy, takeProfit (${tp}) must be above stopLoss (${sl})`
      : `For a Sell, takeProfit (${tp}) must be below stopLoss (${sl})`);
  }
  const entry = o.price ?? o.stopPrice;
  if (entry !== undefined) {
    if (tp !== undefined && (long ? tp <= entry : tp >= entry)) {
      throw new Error(`takeProfit ${tp} is on the wrong side of the entry ${entry} for a ${o.action}`);
    }
    if (sl !== undefined && (long ? sl >= entry : sl <= entry)) {
      throw new Error(`stopLoss ${sl} is on the wrong side of the entry ${entry} for a ${o.action}`);
    }
  }
}

export function describe(o: OrderRequest, symbol: string): string {
  let s = `${o.action.toUpperCase()} ${o.qty} ${symbol} ${o.orderType.toUpperCase()}`;
  if (o.orderType === "Limit") s += ` @ ${o.price}`;
  if (o.orderType === "Stop") s += ` stop ${o.stopPrice}`;
  if (o.orderType === "StopLimit") s += ` stop ${o.stopPrice} limit ${o.price}`;
  s += ` (${o.timeInForce ?? "Day"})`;
  if (o.takeProfit !== undefined) s += `, take profit ${o.takeProfit}`;
  if (o.stopLoss !== undefined) s += `, stop loss ${o.stopLoss}`;
  return s;
}
