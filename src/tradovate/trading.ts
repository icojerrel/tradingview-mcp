import { randomInt } from "crypto";
import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import type { Config } from "./config.js";
import { TradovateClient } from "./client.js";

export type Action = "Buy" | "Sell";
export type OrderType = "Market" | "Limit" | "Stop" | "StopLimit";

export interface OrderRequest {
  symbol: string;
  action: Action;
  qty: number;
  orderType: OrderType;
  price?: number;
  stopPrice?: number;
  timeInForce?: "Day" | "GTC";
  takeProfit?: number;
  stopLoss?: number;
}

interface Account { id: number; name: string }
interface Contract { id: number; name: string }
interface Pending { order: OrderRequest; contract: Contract; account: Account; expiresAt: number }

export class Trading {
  private readonly client: TradovateClient;
  private readonly pending = new Map<string, Pending>();
  private readonly contractCache = new Map<number, string>();
  private account: Account | null = null;

  constructor(private readonly config: Config) {
    this.client = new TradovateClient(config);
  }

  // ─── Read-only ──────────────────────────────────────────────────────────────

  async status() {
    const account = await this.getAccount();
    const balance = await this.client.post("/cashBalance/getcashbalancesnapshot", { accountId: account.id });
    return {
      environment: this.config.env,
      tradingEnabled: this.config.tradingEnabled,
      account: account.name,
      balance,
      limits: this.config.limits,
      ordersPlacedToday: await this.ordersPlacedToday(),
    };
  }

  async positions() {
    const account = await this.getAccount();
    const list: any[] = await this.client.get("/position/list");
    const mine = list.filter((p) => p.accountId === account.id && p.netPos !== 0);
    return Promise.all(mine.map(async (p) => ({
      symbol: await this.contractName(p.contractId),
      netPos: p.netPos,
      avgPrice: p.netPrice ?? null,
    })));
  }

  async workingOrders() {
    const account = await this.getAccount();
    const list: any[] = await this.client.get("/order/list");
    const working = list.filter((o) => o.accountId === account.id && o.ordStatus === "Working");
    return Promise.all(working.map(async (o) => {
      const versions: any[] = await this.client.get(`/orderVersion/deps?masterid=${o.id}`);
      const v = versions[versions.length - 1] ?? {};
      return {
        orderId: o.id,
        symbol: await this.contractName(o.contractId),
        action: o.action,
        qty: v.orderQty ?? null,
        orderType: v.orderType ?? null,
        price: v.price ?? null,
        stopPrice: v.stopPrice ?? null,
        placed: o.timestamp,
      };
    }));
  }

  async fills() {
    const account = await this.getAccount();
    const list: any[] = await this.client.get("/fill/list");
    const ids = new Set((await this.client.get<any[]>("/order/list"))
      .filter((o) => o.accountId === account.id).map((o) => o.id));
    const mine = list.filter((f) => ids.has(f.orderId));
    return Promise.all(mine.map(async (f) => ({
      orderId: f.orderId,
      symbol: await this.contractName(f.contractId),
      action: f.action,
      qty: f.qty,
      price: f.price,
      time: f.timestamp,
    })));
  }

  async findContracts(text: string) {
    const list: any[] = await this.client.get(`/contract/suggest?t=${encodeURIComponent(text)}&l=10`);
    return list.map((c) => ({ symbol: c.name, id: c.id }));
  }

  // ─── Orders: preview → confirm ──────────────────────────────────────────────

  async preview(order: OrderRequest) {
    this.assertTradingEnabled();
    validateShape(order);
    const account = await this.getAccount();
    const contract = await this.resolveContract(order.symbol);
    const position = await this.checkLimits(order, contract, account);

    this.prunePending();
    const code = String(randomInt(100000, 1000000));
    this.pending.set(code, { order, contract, account, expiresAt: Date.now() + this.config.confirmTtlMs });

    return {
      confirmationCode: code,
      expiresInSeconds: Math.round(this.config.confirmTtlMs / 1000),
      environment: this.config.env.toUpperCase(),
      account: account.name,
      summary: describe(order, contract.name),
      order: { ...order, symbol: contract.name },
      currentPosition: position.current,
      positionAfterFill: position.after,
      note: "Nothing has been sent yet. Call tradovate_confirm_order with this code to place it.",
    };
  }

  async confirm(code: string) {
    this.assertTradingEnabled();
    this.prunePending();
    const p = this.pending.get(code);
    if (!p) throw new Error("Unknown or expired confirmation code. Preview the order again.");
    this.pending.delete(code); // single use, also when the order fails below

    // Re-check against the current position and daily count.
    await this.checkLimits(p.order, p.contract, p.account);

    const o = p.order;
    const base = {
      accountSpec: p.account.name,
      accountId: p.account.id,
      action: o.action,
      symbol: p.contract.name,
      orderQty: o.qty,
      orderType: o.orderType,
      timeInForce: o.timeInForce ?? "Day",
      isAutomated: true,
      ...(o.price !== undefined ? { price: o.price } : {}),
      ...(o.stopPrice !== undefined ? { stopPrice: o.stopPrice } : {}),
    };

    const exit: Action = o.action === "Buy" ? "Sell" : "Buy";
    const hasBracket = o.takeProfit !== undefined || o.stopLoss !== undefined;
    const body = hasBracket
      ? {
        ...base,
        ...(o.takeProfit !== undefined ? { bracket1: { action: exit, orderType: "Limit", price: o.takeProfit } } : {}),
        ...(o.stopLoss !== undefined
          ? { [o.takeProfit !== undefined ? "bracket2" : "bracket1"]: { action: exit, orderType: "Stop", stopPrice: o.stopLoss } }
          : {}),
      }
      : base;

    const res = await this.client.post(hasBracket ? "/order/placeOSO" : "/order/placeorder", body);
    if (!res?.orderId) {
      await this.journal("rejected", p.account, body, res);
      throw new Error(`Order rejected: ${res?.failureText || res?.failureReason || JSON.stringify(res)}`);
    }
    await this.journal("placed", p.account, body, res);
    return {
      placed: true,
      environment: this.config.env.toUpperCase(),
      orderId: res.orderId,
      ...(o.takeProfit !== undefined ? { takeProfitOrderId: res.oso1Id } : {}),
      ...(o.stopLoss !== undefined ? { stopLossOrderId: o.takeProfit !== undefined ? res.oso2Id : res.oso1Id } : {}),
      summary: describe(o, p.contract.name),
    };
  }

  async cancel(orderId: number) {
    this.assertTradingEnabled();
    const account = await this.getAccount();
    const res = await this.client.post("/order/cancelorder", { orderId, isAutomated: true });
    if (res?.failureReason) throw new Error(`Cancel failed: ${res.failureText || res.failureReason}`);
    await this.journal("cancelled", account, { orderId }, res);
    return { cancelled: orderId };
  }

  async closePosition(symbol: string) {
    this.assertTradingEnabled();
    const account = await this.getAccount();
    const contract = await this.resolveContract(symbol);
    const list: any[] = await this.client.get("/position/list");
    const pos = list.find((p) => p.accountId === account.id && p.contractId === contract.id);
    if (!pos || pos.netPos === 0) throw new Error(`No open position in ${contract.name}`);
    const res = await this.client.post("/order/liquidateposition", {
      accountId: account.id, contractId: contract.id, admin: false,
    });
    if (!res?.orderId) throw new Error(`Close failed: ${res?.failureText || res?.failureReason || JSON.stringify(res)}`);
    await this.journal("liquidated", account, { symbol: contract.name, netPos: pos.netPos }, res);
    return { closed: contract.name, previousNetPos: pos.netPos, orderId: res.orderId };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private assertTradingEnabled() {
    if (!this.config.tradingEnabled) {
      throw new Error(
        "Trading is disabled: TRADOVATE_ENV=live is read-only unless TRADOVATE_LIVE_TRADING=1 is set."
      );
    }
  }

  private async getAccount(): Promise<Account> {
    if (this.account) return this.account;
    const accounts: any[] = await this.client.get("/account/list");
    const active = accounts.filter((a) => a.active !== false);
    const wanted = this.config.account;
    const acc = wanted ? active.find((a) => a.name === wanted || String(a.id) === wanted) : active[0];
    if (!acc) {
      const names = active.map((a) => a.name).join(", ") || "(none)";
      throw new Error(wanted ? `Account "${wanted}" not found. Available: ${names}` : "No active Tradovate account found");
    }
    this.account = { id: acc.id, name: acc.name };
    return this.account;
  }

  private async resolveContract(symbol: string): Promise<Contract> {
    const name = symbol.trim().toUpperCase();
    const c = await this.client.get(`/contract/find?name=${encodeURIComponent(name)}`);
    if (!c?.id) {
      throw new Error(`Unknown contract "${name}". Use the full contract name, e.g. MESZ6 (find it with tradovate_find_contract).`);
    }
    this.contractCache.set(c.id, c.name);
    return { id: c.id, name: c.name };
  }

  private async contractName(id: number): Promise<string> {
    const cached = this.contractCache.get(id);
    if (cached) return cached;
    const c = await this.client.get(`/contract/item?id=${id}`);
    const name = c?.name ?? `contract#${id}`;
    this.contractCache.set(id, name);
    return name;
  }

  private async checkLimits(order: OrderRequest, contract: Contract, account: Account) {
    const { maxOrderQty, maxPosition, maxOrdersPerDay, allowedProducts } = this.config.limits;

    if (allowedProducts) {
      const product = productRoot(contract.name);
      if (!allowedProducts.includes(product)) {
        throw new Error(`Product ${product} is not allowed (TRADOVATE_ALLOWED_PRODUCTS=${allowedProducts.join(",")})`);
      }
    }
    if (order.qty > maxOrderQty) {
      throw new Error(`Quantity ${order.qty} exceeds the per-order limit of ${maxOrderQty} (TRADOVATE_MAX_ORDER_QTY)`);
    }
    const today = await this.ordersPlacedToday();
    if (today >= maxOrdersPerDay) {
      throw new Error(`Daily order limit reached (${today}/${maxOrdersPerDay}, TRADOVATE_MAX_ORDERS_PER_DAY)`);
    }

    const list: any[] = await this.client.get("/position/list");
    const current = list.find((p) => p.accountId === account.id && p.contractId === contract.id)?.netPos ?? 0;
    const after = current + (order.action === "Buy" ? order.qty : -order.qty);
    // Orders that shrink the position are always allowed.
    if (Math.abs(after) > maxPosition && Math.abs(after) > Math.abs(current)) {
      throw new Error(
        `Position in ${contract.name} would become ${after}, above the limit of ±${maxPosition} (TRADOVATE_MAX_POSITION)`
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
        if (e.event === "placed" && e.env === this.config.env && String(e.ts).startsWith(day)) count++;
      } catch { /* skip corrupt line */ }
    }
    return count;
  }

  private async journal(event: string, account: Account, request: unknown, response: unknown) {
    const entry = { ts: new Date().toISOString(), env: this.config.env, event, account: account.name, request, response };
    await appendFile(this.config.journalFile, JSON.stringify(entry) + "\n");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "MESZ6" → "MES", "NQH27" → "NQ". */
export function productRoot(contractName: string): string {
  const m = contractName.toUpperCase().match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m ? m[1] : contractName.toUpperCase();
}

function validateShape(o: OrderRequest) {
  if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error("qty must be a positive whole number");
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

function describe(o: OrderRequest, symbol: string): string {
  let s = `${o.action.toUpperCase()} ${o.qty} ${symbol} ${o.orderType.toUpperCase()}`;
  if (o.orderType === "Limit") s += ` @ ${o.price}`;
  if (o.orderType === "Stop") s += ` stop ${o.stopPrice}`;
  if (o.orderType === "StopLimit") s += ` stop ${o.stopPrice} limit ${o.price}`;
  s += ` (${o.timeInForce ?? "Day"})`;
  if (o.takeProfit !== undefined) s += `, take profit ${o.takeProfit}`;
  if (o.stopLoss !== undefined) s += `, stop loss ${o.stopLoss}`;
  return s;
}
