import { BrokerRejection, type Broker, type Instrument, type OrderRequest } from "../broker.js";

/**
 * Alpaca broker (https://docs.alpaca.markets) — US stocks/ETFs and crypto.
 * ALPACA_ENV=paper (default) uses the free paper-trading account.
 */

class AlpacaHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown, readonly detail = message) {
    super(message);
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
/** "BTC/USD" and "BTCUSD" refer to the same crypto pair; positions use the latter. */
const plain = (s: string) => s.replace("/", "").toUpperCase();

export class AlpacaBroker implements Broker {
  readonly name = "alpaca";
  readonly isLive: boolean;
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly secret: string;

  constructor() {
    const env = (process.env.ALPACA_ENV ?? "paper").toLowerCase();
    if (env !== "paper" && env !== "live") throw new Error(`ALPACA_ENV must be "paper" or "live", got "${env}"`);
    this.isLive = env === "live";
    this.baseUrl = process.env.ALPACA_BASE_URL
      ?? (this.isLive ? "https://api.alpaca.markets/v2" : "https://paper-api.alpaca.markets/v2");
    this.keyId = process.env.ALPACA_API_KEY_ID ?? "";
    this.secret = process.env.ALPACA_API_SECRET_KEY ?? "";
  }

  async account() {
    const a = await this.req("GET", "/account");
    return {
      account: a.account_number,
      balance: {
        currency: a.currency,
        cash: num(a.cash),
        equity: num(a.equity),
        buyingPower: num(a.buying_power),
        status: a.status,
      },
    };
  }

  async positions() {
    const list: any[] = await this.req("GET", "/positions");
    return list.map((p) => ({
      symbol: plain(p.symbol),
      qty: Number(p.qty), // negative for shorts
      avgPrice: num(p.avg_entry_price),
      unrealizedPnl: num(p.unrealized_pl),
    }));
  }

  async workingOrders() {
    const list: any[] = await this.req("GET", "/orders?status=open&nested=true&limit=100");
    const flat = list.flatMap((o) => [o, ...(o.legs ?? [])]).filter((o) => !["filled", "canceled", "expired"].includes(o.status));
    return flat.map((o) => ({
      orderId: o.id,
      symbol: plain(o.symbol),
      action: o.side === "buy" ? "Buy" : "Sell",
      qty: num(o.qty),
      orderType: o.type,
      price: num(o.limit_price),
      stopPrice: num(o.stop_price),
      placed: o.submitted_at ?? o.created_at ?? null,
    }));
  }

  async fills() {
    const list: any[] = await this.req("GET", "/account/activities/FILL?direction=desc&page_size=100");
    return list.map((f) => ({
      orderId: f.order_id,
      symbol: plain(f.symbol),
      action: f.side === "buy" ? "Buy" : "Sell",
      qty: Number(f.qty),
      price: Number(f.price),
      time: f.transaction_time,
    }));
  }

  async findSymbols(text: string) {
    try {
      const a = await this.asset(text);
      return [{ symbol: plain(a.symbol), description: `${a.name} (${a.class}${a.tradable ? "" : ", not tradable"})` }];
    } catch {
      return [];
    }
  }

  async resolve(symbol: string): Promise<Instrument> {
    let a;
    try {
      a = await this.asset(symbol);
    } catch (err) {
      if (err instanceof AlpacaHttpError && err.status === 404) {
        throw new Error(`Unknown symbol "${symbol}" at Alpaca (use e.g. AAPL, SPY, BTC/USD)`);
      }
      throw err;
    }
    if (!a.tradable) throw new Error(`${a.symbol} is not tradable at Alpaca`);
    return { symbol: plain(a.symbol), product: plain(a.symbol), ref: { orderSymbol: a.symbol, assetClass: a.class, fractionable: a.fractionable } };
  }

  validate(order: OrderRequest, inst: Instrument) {
    const ref = inst.ref as { fractionable: boolean };
    if (!Number.isInteger(order.qty) && !ref.fractionable) {
      throw new Error(`${inst.symbol} cannot be traded in fractions at Alpaca`);
    }
  }

  async place(o: OrderRequest, inst: Instrument) {
    const ref = inst.ref as { orderSymbol: string; assetClass: string };
    const crypto = ref.assetClass === "crypto";
    const body: Record<string, unknown> = {
      symbol: ref.orderSymbol,
      qty: String(o.qty),
      side: o.action === "Buy" ? "buy" : "sell",
      type: { Market: "market", Limit: "limit", Stop: "stop", StopLimit: "stop_limit" }[o.orderType],
      // Crypto only supports gtc/ioc.
      time_in_force: crypto ? "gtc" : (o.timeInForce ?? "Day").toLowerCase(),
      client_order_id: `mcp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
    if (o.price !== undefined) body.limit_price = String(o.price);
    if (o.stopPrice !== undefined) body.stop_price = String(o.stopPrice);
    if (o.takeProfit !== undefined) body.take_profit = { limit_price: String(o.takeProfit) };
    if (o.stopLoss !== undefined) body.stop_loss = { stop_price: String(o.stopLoss) };
    if (o.takeProfit !== undefined || o.stopLoss !== undefined) {
      body.order_class = o.takeProfit !== undefined && o.stopLoss !== undefined ? "bracket" : "oto";
    }

    let res;
    try {
      res = await this.req("POST", "/orders", body);
    } catch (err) {
      // 403 here means e.g. insufficient buying power, not bad keys.
      if (err instanceof AlpacaHttpError && err.status >= 400 && err.status < 500 && err.status !== 401) {
        throw new BrokerRejection(err.detail, { request: body, response: err.body });
      }
      throw err;
    }
    const legs: any[] = res.legs ?? [];
    const tpLeg = legs.find((l) => l.type === "limit");
    const slLeg = legs.find((l) => l.type === "stop" || l.type === "stop_limit");
    return {
      orderId: res.id,
      status: res.status,
      ...(tpLeg ? { takeProfitOrderId: tpLeg.id } : {}),
      ...(slLeg ? { stopLossOrderId: slLeg.id } : {}),
      raw: { request: body, response: res },
    };
  }

  async cancel(orderId: string) {
    try {
      await this.req("DELETE", `/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      if (err instanceof AlpacaHttpError && (err.status === 404 || err.status === 422)) {
        throw new BrokerRejection(err.detail, err.body);
      }
      throw err;
    }
  }

  async close(inst: Instrument) {
    const pos = (await this.positions()).find((p) => p.symbol === inst.symbol);
    if (!pos || pos.qty === 0) throw new Error(`No open position in ${inst.symbol}`);
    const res = await this.req("DELETE", `/positions/${encodeURIComponent(inst.symbol)}`);
    return { orderId: res?.id ?? "", previousQty: pos.qty };
  }

  private asset(symbol: string) {
    // Accept TradingView style "NASDAQ:AAPL" too.
    const s = symbol.trim().toUpperCase().replace(/^[A-Z_]+:/, "");
    return this.req("GET", `/assets/${encodeURIComponent(s)}`);
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.keyId || !this.secret) {
      throw new Error("Missing Alpaca API keys: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY");
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "APCA-API-KEY-ID": this.keyId,
        "APCA-API-SECRET-KEY": this.secret,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && data.message) || text || res.statusText;
      if (res.status === 401) {
        throw new AlpacaHttpError(`Alpaca refused the API keys (401): ${msg}`, res.status, data, String(msg));
      }
      if (res.status === 403) {
        throw new AlpacaHttpError(`Alpaca refused the request (403): ${msg}`, res.status, data, String(msg));
      }
      throw new AlpacaHttpError(String(msg), res.status, data);
    }
    return data;
  }
}
