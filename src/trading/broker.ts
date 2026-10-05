/**
 * Broker abstraction. The safety layer (safety.ts) only talks to this
 * interface, so every broker gets the same preview → confirm flow, limits
 * and journal.
 */

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

export interface Instrument {
  /** Broker's canonical symbol, e.g. MESZ6, AAPL, BINANCE:BTCUSDT */
  symbol: string;
  /** What TRADING_ALLOWED_PRODUCTS is matched against, e.g. MES, AAPL, BTCUSDT */
  product: string;
  /** Broker-specific handle (contract id, ...) */
  ref?: unknown;
}

export interface Position { symbol: string; qty: number; avgPrice: number | null; unrealizedPnl?: number | null }

export interface WorkingOrder {
  orderId: string;
  symbol: string;
  action: Action | string;
  qty: number | null;
  orderType: string | null;
  price: number | null;
  stopPrice: number | null;
  placed: string | null;
}

export interface Fill { orderId: string; symbol: string; action: string; qty: number; price: number; time: string }

export interface PlaceResult {
  orderId: string;
  takeProfitOrderId?: string;
  stopLossOrderId?: string;
  status?: string;
  raw?: unknown;
}

/** Thrown when the broker refuses an order; the safety layer journals these. */
export class BrokerRejection extends Error {
  constructor(message: string, readonly raw: unknown) {
    super(message);
  }
}

export interface Broker {
  readonly name: string;
  /** True when orders would hit a real-money account. */
  readonly isLive: boolean;

  account(): Promise<{ account: string; balance: Record<string, unknown> }>;
  positions(): Promise<Position[]>;
  workingOrders(): Promise<WorkingOrder[]>;
  fills(): Promise<Fill[]>;
  findSymbols?(text: string): Promise<{ symbol: string; description?: string }[]>;

  resolve(symbol: string): Promise<Instrument>;
  /** Broker-specific order checks (e.g. whole contracts only). Throw to refuse. */
  validate?(order: OrderRequest, instrument: Instrument): void;
  place(order: OrderRequest, instrument: Instrument): Promise<PlaceResult>;
  cancel(orderId: string): Promise<void>;
  close(instrument: Instrument): Promise<{ orderId: string; previousQty: number }>;
}
