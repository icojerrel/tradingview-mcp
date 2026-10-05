import { existsSync } from "fs";
import { readFile, rename, writeFile } from "fs/promises";
import { getQuote } from "../../market.js";
import { BrokerRejection, type Action, type Broker, type Instrument, type OrderRequest } from "../broker.js";

/**
 * Built-in paper-trading broker: a local simulated account that fills
 * orders against live TradingView prices. Needs no broker account.
 *
 * Fill model (simple on purpose, see README):
 *  - Market: fills at the last price.
 *  - Limit: fills at the last price if marketable when placed, otherwise at
 *    the limit price once the last price reaches it.
 *  - Stop: becomes a market order once the last price reaches the stop.
 *  - StopLimit: becomes a limit order once the stop is reached.
 *  - take-profit / stop-loss become an OCO pair once the entry fills.
 * Working orders are checked on every tool call and every
 * TRADING_PAPER_POLL_SEC seconds while the server runs. No slippage,
 * commissions, market hours or partial fills.
 */

type Status = "Working" | "Filled" | "Canceled" | "Expired";

interface PaperOrder {
  id: string;
  symbol: string;
  action: Action;
  qty: number;
  orderType: OrderRequest["orderType"];
  price?: number;
  stopPrice?: number;
  timeInForce: "Day" | "GTC";
  status: Status;
  triggered?: boolean;
  /** Brackets to create when this entry fills */
  brackets?: { takeProfit?: number; stopLoss?: number; takeProfitId?: string; stopLossId?: string };
  ocoGroup?: string;
  placed: string;
  filledAt?: string;
  fillPrice?: number;
}

interface PaperState {
  startCash: number;
  cash: number;
  realizedPnl: number;
  nextId: number;
  positions: Record<string, { qty: number; avgPrice: number }>;
  orders: PaperOrder[];
  fills: { orderId: string; symbol: string; action: Action; qty: number; price: number; time: string }[];
}

/** Last-price source: TradingView by default, or a JSON file of fixed prices. */
export interface PriceSource { price(symbol: string): Promise<number> }

class TradingViewPrices implements PriceSource {
  async price(symbol: string) {
    let q;
    try {
      [q] = await getQuote([symbol]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`No TradingView price for ${symbol} (${msg})`);
    }
    if (typeof q?.close !== "number") throw new Error(`No TradingView price for ${symbol}. Use EXCHANGE:TICKER, e.g. NASDAQ:AAPL`);
    return q.close;
  }
}

/** Offline / manual mode: prices come from a JSON file {"NASDAQ:AAPL": 190.5}. Re-read on every lookup. */
class FilePrices implements PriceSource {
  constructor(private readonly file: string) {}
  async price(symbol: string) {
    const data = JSON.parse(await readFile(this.file, "utf-8"));
    const p = data[symbol];
    if (typeof p !== "number") throw new Error(`No price for ${symbol} in ${this.file}`);
    return p;
  }
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly isLive = false;
  private readonly stateFile = process.env.TRADING_PAPER_STATE_FILE ?? ".paper_account.json";
  private readonly startCash = Number(process.env.TRADING_PAPER_START_CASH ?? 100_000);
  private readonly prices: PriceSource = process.env.TRADING_PAPER_PRICES_FILE
    ? new FilePrices(process.env.TRADING_PAPER_PRICES_FILE)
    : new TradingViewPrices();
  private readonly pointValues = parsePointValues(process.env.TRADING_PAPER_POINT_VALUES);
  private lock: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const pollSec = Number(process.env.TRADING_PAPER_POLL_SEC ?? 15);
    if (pollSec > 0) {
      this.timer = setInterval(() => {
        this.exclusive(async (s) => { await this.evaluate(s); })
          .catch((err) => console.error(`[paper] price check failed: ${err instanceof Error ? err.message : err}`));
      }, pollSec * 1000);
      this.timer.unref();
    }
  }

  async account() {
    return this.exclusive(async (s) => {
      await this.evaluate(s);
      let unrealized = 0;
      for (const [sym, p] of Object.entries(s.positions)) {
        unrealized += (await this.prices.price(sym) - p.avgPrice) * p.qty * this.pointValue(sym);
      }
      return {
        account: "PAPER",
        balance: {
          startCash: s.startCash,
          realizedPnl: round(s.realizedPnl),
          unrealizedPnl: round(unrealized),
          equity: round(s.startCash + s.realizedPnl + unrealized),
        },
      };
    });
  }

  async positions() {
    return this.exclusive(async (s) => {
      await this.evaluate(s);
      const out = [];
      for (const [symbol, p] of Object.entries(s.positions)) {
        const last = await this.prices.price(symbol);
        out.push({
          symbol, qty: p.qty, avgPrice: round(p.avgPrice), lastPrice: last,
          unrealizedPnl: round((last - p.avgPrice) * p.qty * this.pointValue(symbol)),
        });
      }
      return out;
    });
  }

  async workingOrders() {
    return this.exclusive(async (s) => {
      await this.evaluate(s);
      return s.orders.filter((o) => o.status === "Working").map((o) => ({
        orderId: o.id, symbol: o.symbol, action: o.action, qty: o.qty,
        orderType: o.triggered && o.orderType === "StopLimit" ? "Limit (stop triggered)" : o.orderType,
        price: o.price ?? null, stopPrice: o.stopPrice ?? null, placed: o.placed,
      }));
    });
  }

  async fills() {
    return this.exclusive(async (s) => {
      await this.evaluate(s);
      return s.fills.map((f) => ({ ...f }));
    });
  }

  async resolve(symbol: string): Promise<Instrument> {
    const sym = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9_]+:[A-Z0-9_.!/-]+$/.test(sym)) {
      throw new Error(`Use the TradingView format EXCHANGE:TICKER for paper trading, e.g. NASDAQ:AAPL, BINANCE:BTCUSDT, CME_MINI:MES1!`);
    }
    await this.prices.price(sym); // proves the symbol has a price
    return { symbol: sym, product: sym.split(":")[1] };
  }

  async place(o: OrderRequest, inst: Instrument) {
    return this.exclusive(async (s) => {
      const order: PaperOrder = {
        id: `P${s.nextId++}`,
        symbol: inst.symbol,
        action: o.action,
        qty: o.qty,
        orderType: o.orderType,
        price: o.price,
        stopPrice: o.stopPrice,
        timeInForce: o.timeInForce ?? "Day",
        status: "Working",
        placed: new Date().toISOString(),
      };
      if (o.takeProfit !== undefined || o.stopLoss !== undefined) {
        order.brackets = { takeProfit: o.takeProfit, stopLoss: o.stopLoss };
      }
      s.orders.push(order);
      const last = await this.prices.price(order.symbol);
      this.tryFill(s, order, last, true);
      await this.evaluate(s);
      return {
        orderId: order.id,
        status: order.status,
        ...(order.fillPrice !== undefined ? { fillPrice: order.fillPrice } : {}),
        ...(order.brackets?.takeProfitId ? { takeProfitOrderId: order.brackets.takeProfitId } : {}),
        ...(order.brackets?.stopLossId ? { stopLossOrderId: order.brackets.stopLossId } : {}),
      };
    });
  }

  async cancel(orderId: string) {
    await this.exclusive(async (s) => {
      await this.evaluate(s);
      const o = s.orders.find((x) => x.id === orderId);
      if (!o) throw new BrokerRejection(`Unknown order ${orderId}`, null);
      if (o.status !== "Working") throw new BrokerRejection(`Order ${orderId} is not working (${o.status})`, null);
      o.status = "Canceled";
    });
  }

  async close(inst: Instrument) {
    return this.exclusive(async (s) => {
      await this.evaluate(s);
      const pos = s.positions[inst.symbol];
      if (!pos || pos.qty === 0) throw new Error(`No open position in ${inst.symbol}`);
      const previousQty = pos.qty;
      // Exits attached to this position would re-open it after the close.
      for (const o of s.orders) if (o.symbol === inst.symbol && o.status === "Working" && o.ocoGroup) o.status = "Canceled";
      const order: PaperOrder = {
        id: `P${s.nextId++}`, symbol: inst.symbol, action: previousQty > 0 ? "Sell" : "Buy",
        qty: Math.abs(previousQty), orderType: "Market", timeInForce: "Day", status: "Working",
        placed: new Date().toISOString(),
      };
      s.orders.push(order);
      this.tryFill(s, order, await this.prices.price(inst.symbol), true);
      return { orderId: order.id, previousQty, fillPrice: order.fillPrice };
    });
  }

  // ─── Simulation ─────────────────────────────────────────────────────────────

  /** Checks all working orders against the current prices. */
  private async evaluate(s: PaperState) {
    const today = new Date().toISOString().slice(0, 10);
    const cache = new Map<string, number>();
    // Loop because a fill can create bracket orders that may fill right away.
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (const o of s.orders.filter((x) => x.status === "Working")) {
        if (o.timeInForce === "Day" && o.placed.slice(0, 10) !== today) {
          o.status = "Expired";
          continue;
        }
        if (!cache.has(o.symbol)) cache.set(o.symbol, await this.prices.price(o.symbol));
        if (this.tryFill(s, o, cache.get(o.symbol)!, false)) changed = true;
      }
      if (!changed) break;
    }
  }

  private tryFill(s: PaperState, o: PaperOrder, last: number, atPlacement: boolean): boolean {
    if (o.status !== "Working") return false;
    const buy = o.action === "Buy";
    let fillPrice: number | null = null;

    if (o.orderType === "StopLimit" && !o.triggered && (buy ? last >= o.stopPrice! : last <= o.stopPrice!)) {
      o.triggered = true;
      atPlacement = true; // from here it behaves like a freshly placed limit
    }
    const asLimit = o.orderType === "Limit" || (o.orderType === "StopLimit" && o.triggered);

    if (o.orderType === "Market") fillPrice = last;
    else if (asLimit && (buy ? last <= o.price! : last >= o.price!)) fillPrice = atPlacement ? last : o.price!;
    else if (o.orderType === "Stop" && (buy ? last >= o.stopPrice! : last <= o.stopPrice!)) fillPrice = last;
    if (fillPrice === null) return false;

    o.status = "Filled";
    o.fillPrice = fillPrice;
    o.filledAt = new Date().toISOString();
    this.applyFill(s, o.symbol, buy ? o.qty : -o.qty, fillPrice);
    s.fills.push({ orderId: o.id, symbol: o.symbol, action: o.action, qty: o.qty, price: fillPrice, time: o.filledAt });

    if (o.ocoGroup) {
      for (const x of s.orders) if (x.ocoGroup === o.ocoGroup && x.id !== o.id && x.status === "Working") x.status = "Canceled";
    }
    if (o.brackets) {
      const exit: Action = buy ? "Sell" : "Buy";
      const group = `OCO-${o.id}`;
      const mk = (orderType: "Limit" | "Stop", px: number): PaperOrder => ({
        id: `P${s.nextId++}`, symbol: o.symbol, action: exit, qty: o.qty, orderType,
        ...(orderType === "Limit" ? { price: px } : { stopPrice: px }),
        timeInForce: "GTC", status: "Working", ocoGroup: group, placed: new Date().toISOString(),
      });
      if (o.brackets.takeProfit !== undefined) {
        const tp = mk("Limit", o.brackets.takeProfit);
        o.brackets.takeProfitId = tp.id;
        s.orders.push(tp);
      }
      if (o.brackets.stopLoss !== undefined) {
        const sl = mk("Stop", o.brackets.stopLoss);
        o.brackets.stopLossId = sl.id;
        s.orders.push(sl);
      }
    }
    return true;
  }

  private applyFill(s: PaperState, symbol: string, signedQty: number, price: number) {
    const m = this.pointValue(symbol);
    const pos = s.positions[symbol] ?? { qty: 0, avgPrice: 0 };
    let { qty, avgPrice } = pos;
    if (qty === 0 || sign(qty) === sign(signedQty)) {
      const newQty = qty + signedQty;
      avgPrice = (avgPrice * Math.abs(qty) + price * Math.abs(signedQty)) / Math.abs(newQty);
      qty = newQty;
    } else {
      const closing = Math.min(Math.abs(signedQty), Math.abs(qty));
      s.realizedPnl += closing * (price - avgPrice) * sign(qty) * m;
      const newQty = round(qty + signedQty);
      if (newQty !== 0 && sign(newQty) !== sign(qty)) avgPrice = price;
      qty = newQty;
    }
    s.cash -= signedQty * price * m;
    if (qty === 0) delete s.positions[symbol];
    else s.positions[symbol] = { qty: round(qty), avgPrice };
  }

  private pointValue(symbol: string): number {
    return this.pointValues[symbol] ?? this.pointValues[symbol.split(":")[1]] ?? 1;
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  /** Runs fn on the loaded state and saves it afterwards; calls are serialized. */
  private exclusive<T>(fn: (s: PaperState) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const state = await this.load();
      try {
        return await fn(state);
      } finally {
        await this.save(state);
      }
    });
    this.lock = run.catch(() => {});
    return run;
  }

  private async load(): Promise<PaperState> {
    if (!existsSync(this.stateFile)) {
      return { startCash: this.startCash, cash: this.startCash, realizedPnl: 0, nextId: 1, positions: {}, orders: [], fills: [] };
    }
    return JSON.parse(await readFile(this.stateFile, "utf-8"));
  }

  private async save(s: PaperState) {
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2));
    await rename(tmp, this.stateFile);
  }
}

/** "CME_MINI:MES1!=5,MNQ1!=2" → { "CME_MINI:MES1!": 5, "MNQ1!": 2 } */
function parsePointValues(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x?.trim());
    if (!k) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`TRADING_PAPER_POINT_VALUES: bad value for ${k}`);
    out[k.toUpperCase()] = n;
  }
  return out;
}
