import { BrokerRejection, type Broker, type Instrument, type OrderRequest } from "../broker.js";
import { TradovateClient } from "./tradovate-client.js";

/**
 * Tradovate futures broker (https://api.tradovate.com).
 * TRADOVATE_ENV=demo (default) is the paper account.
 */

interface Account { id: number; name: string }

/** "MESZ6" → "MES", "NQH27" → "NQ". */
export function productRoot(contractName: string): string {
  const m = contractName.toUpperCase().match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m ? m[1] : contractName.toUpperCase();
}

export class TradovateBroker implements Broker {
  readonly name = "tradovate";
  readonly isLive: boolean;
  private readonly client: TradovateClient;
  private readonly wantedAccount: string | null;
  private accountCache: Account | null = null;
  private readonly contractNames = new Map<number, string>();

  constructor() {
    const env = (process.env.TRADOVATE_ENV ?? "demo").toLowerCase();
    if (env !== "demo" && env !== "live") throw new Error(`TRADOVATE_ENV must be "demo" or "live", got "${env}"`);
    this.isLive = env === "live";
    this.wantedAccount = process.env.TRADOVATE_ACCOUNT?.trim() || null;
    this.client = new TradovateClient({
      baseUrl: process.env.TRADOVATE_BASE_URL ?? `https://${env}.tradovateapi.com/v1`,
      credentials: {
        name: process.env.TRADOVATE_USERNAME ?? "",
        password: process.env.TRADOVATE_PASSWORD ?? "",
        appId: process.env.TRADOVATE_APP_ID ?? "tradingview-mcp",
        appVersion: process.env.TRADOVATE_APP_VERSION ?? "1.0",
        cid: process.env.TRADOVATE_CID ?? "",
        sec: process.env.TRADOVATE_SEC ?? "",
        deviceId: process.env.TRADOVATE_DEVICE_ID ?? "tradingview-mcp",
      },
    });
  }

  async account() {
    const acc = await this.getAccount();
    const balance = await this.client.post("/cashBalance/getcashbalancesnapshot", { accountId: acc.id });
    return { account: acc.name, balance };
  }

  async positions() {
    const acc = await this.getAccount();
    const list: any[] = await this.client.get("/position/list");
    const mine = list.filter((p) => p.accountId === acc.id && p.netPos !== 0);
    return Promise.all(mine.map(async (p) => ({
      symbol: await this.contractName(p.contractId),
      qty: p.netPos,
      avgPrice: p.netPrice ?? null,
    })));
  }

  async workingOrders() {
    const acc = await this.getAccount();
    const list: any[] = await this.client.get("/order/list");
    const working = list.filter((o) => o.accountId === acc.id && o.ordStatus === "Working");
    return Promise.all(working.map(async (o) => {
      const versions: any[] = await this.client.get(`/orderVersion/deps?masterid=${o.id}`);
      const v = versions[versions.length - 1] ?? {};
      return {
        orderId: String(o.id),
        symbol: await this.contractName(o.contractId),
        action: o.action,
        qty: v.orderQty ?? null,
        orderType: v.orderType ?? null,
        price: v.price ?? null,
        stopPrice: v.stopPrice ?? null,
        placed: o.timestamp ?? null,
      };
    }));
  }

  async fills() {
    const acc = await this.getAccount();
    const ids = new Set((await this.client.get<any[]>("/order/list"))
      .filter((o) => o.accountId === acc.id).map((o) => o.id));
    const list: any[] = await this.client.get("/fill/list");
    return Promise.all(list.filter((f) => ids.has(f.orderId)).map(async (f) => ({
      orderId: String(f.orderId),
      symbol: await this.contractName(f.contractId),
      action: f.action,
      qty: f.qty,
      price: f.price,
      time: f.timestamp,
    })));
  }

  async findSymbols(text: string) {
    const list: any[] = await this.client.get(`/contract/suggest?t=${encodeURIComponent(text)}&l=10`);
    return list.map((c) => ({ symbol: c.name }));
  }

  async resolve(symbol: string): Promise<Instrument> {
    const name = symbol.trim().toUpperCase();
    const c = await this.client.get(`/contract/find?name=${encodeURIComponent(name)}`);
    if (!c?.id) {
      throw new Error(`Unknown contract "${name}". Use the full contract name, e.g. MESZ6 (find it with trade_find_symbol).`);
    }
    this.contractNames.set(c.id, c.name);
    return { symbol: c.name, product: productRoot(c.name), ref: c.id };
  }

  validate(order: OrderRequest) {
    if (!Number.isInteger(order.qty)) throw new Error("Tradovate futures need a whole number of contracts");
  }

  async place(o: OrderRequest, inst: Instrument) {
    const acc = await this.getAccount();
    const base = {
      accountSpec: acc.name,
      accountId: acc.id,
      action: o.action,
      symbol: inst.symbol,
      orderQty: o.qty,
      orderType: o.orderType,
      timeInForce: o.timeInForce ?? "Day",
      isAutomated: true,
      ...(o.price !== undefined ? { price: o.price } : {}),
      ...(o.stopPrice !== undefined ? { stopPrice: o.stopPrice } : {}),
    };
    const exit = o.action === "Buy" ? "Sell" : "Buy";
    const tp = o.takeProfit !== undefined ? { action: exit, orderType: "Limit", price: o.takeProfit } : null;
    const sl = o.stopLoss !== undefined ? { action: exit, orderType: "Stop", stopPrice: o.stopLoss } : null;
    const brackets = [tp, sl].filter(Boolean);
    const body = brackets.length
      ? { ...base, bracket1: brackets[0], ...(brackets[1] ? { bracket2: brackets[1] } : {}) }
      : base;

    const res = await this.client.post(brackets.length ? "/order/placeOSO" : "/order/placeorder", body);
    if (!res?.orderId) {
      throw new BrokerRejection(res?.failureText || res?.failureReason || JSON.stringify(res), { request: body, response: res });
    }
    return {
      orderId: String(res.orderId),
      ...(tp ? { takeProfitOrderId: String(res.oso1Id) } : {}),
      ...(sl ? { stopLossOrderId: String(tp ? res.oso2Id : res.oso1Id) } : {}),
      raw: { request: body, response: res },
    };
  }

  async cancel(orderId: string) {
    const res = await this.client.post("/order/cancelorder", { orderId: Number(orderId), isAutomated: true });
    if (res?.failureReason) throw new BrokerRejection(res.failureText || res.failureReason, res);
  }

  async close(inst: Instrument) {
    const acc = await this.getAccount();
    const list: any[] = await this.client.get("/position/list");
    const pos = list.find((p) => p.accountId === acc.id && p.contractId === inst.ref);
    if (!pos || pos.netPos === 0) throw new Error(`No open position in ${inst.symbol}`);
    const res = await this.client.post("/order/liquidateposition", { accountId: acc.id, contractId: inst.ref, admin: false });
    if (!res?.orderId) throw new Error(`Close failed: ${res?.failureText || res?.failureReason || JSON.stringify(res)}`);
    return { orderId: String(res.orderId), previousQty: pos.netPos };
  }

  private async getAccount(): Promise<Account> {
    if (this.accountCache) return this.accountCache;
    const accounts: any[] = await this.client.get("/account/list");
    const active = accounts.filter((a) => a.active !== false);
    const wanted = this.wantedAccount;
    const acc = wanted ? active.find((a) => a.name === wanted || String(a.id) === wanted) : active[0];
    if (!acc) {
      const names = active.map((a) => a.name).join(", ") || "(none)";
      throw new Error(wanted ? `Account "${wanted}" not found. Available: ${names}` : "No active Tradovate account found");
    }
    this.accountCache = { id: acc.id, name: acc.name };
    return this.accountCache;
  }

  private async contractName(id: number): Promise<string> {
    const cached = this.contractNames.get(id);
    if (cached) return cached;
    const c = await this.client.get(`/contract/item?id=${id}`);
    const name = c?.name ?? `contract#${id}`;
    this.contractNames.set(id, name);
    return name;
  }
}
