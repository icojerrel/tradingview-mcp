// End-to-end test of the trading MCP server with TRADING_BROKER=alpaca.
//
// Runs a local stand-in for the Alpaca Trading API v2 (same paths, headers,
// string-typed numbers, 4xx {code,message} errors, nested bracket legs) and
// points the server at it with ALPACA_BASE_URL.
//
//   npm run build && node test/trading-alpaca-e2e.mjs

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { startMcp as start, data, err, step, run } from "./helpers/mcp.mjs";

// ── Mock Alpaca API ─────────────────────────────────────────────────────────
const ASSETS = {
  AAPL: { symbol: "AAPL", name: "Apple Inc.", class: "us_equity", tradable: true, fractionable: true },
  GME: { symbol: "GME", name: "GameStop", class: "us_equity", tradable: true, fractionable: false },
  OLD: { symbol: "OLD", name: "Delisted Co", class: "us_equity", tradable: false, fractionable: false },
  "BTC/USD": { symbol: "BTC/USD", name: "Bitcoin", class: "crypto", tradable: true, fractionable: true },
};
const LAST = { AAPL: 200, GME: 25, "BTC/USD": 60000 };
const api = { requests: [], orders: [], positions: {}, fills: [], n: 0 };
const posKey = (s) => s.replace("/", "");

function fillOrder(o) {
  const px = LAST[o.symbol];
  const k = posKey(o.symbol);
  const q = (o.side === "buy" ? 1 : -1) * Number(o.qty);
  const p = api.positions[k] ?? { qty: 0, avg: px };
  p.qty += q;
  p.avg = px;
  if (p.qty === 0) delete api.positions[k]; else api.positions[k] = p;
  o.status = "filled";
  api.fills.push({ order_id: o.id, symbol: k, side: o.side, qty: o.qty, price: String(px), transaction_time: new Date().toISOString() });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/v2/, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  api.requests.push({ method: req.method, path, body });
  const send = (code, d) => { res.writeHead(code, { "content-type": "application/json" }); res.end(d === undefined ? "" : JSON.stringify(d)); };

  if (req.headers["apca-api-key-id"] !== "PKTEST" || req.headers["apca-api-secret-key"] !== "s3cret") {
    return send(401, { code: 40110000, message: "request is not authorized" });
  }
  if (req.method === "GET" && path === "/account") {
    return send(200, { account_number: "PA3TEST", status: "ACTIVE", currency: "USD", cash: "100000", equity: "100000", buying_power: "200000" });
  }
  if (req.method === "GET" && path.startsWith("/assets/")) {
    const a = ASSETS[decodeURIComponent(path.slice(8))];
    return a ? send(200, a) : send(404, { code: 40410000, message: "asset not found" });
  }
  if (req.method === "GET" && path === "/positions") {
    return send(200, Object.entries(api.positions).map(([symbol, p]) => ({
      symbol, qty: String(p.qty), avg_entry_price: String(p.avg), side: p.qty > 0 ? "long" : "short", unrealized_pl: "0",
    })));
  }
  if (req.method === "GET" && path === "/orders") {
    return send(200, api.orders.filter((o) => !o.parent && ["new", "accepted", "held"].includes(o.status) || (!o.parent && o.legs?.some((l) => l.status === "held"))));
  }
  if (req.method === "GET" && path === "/account/activities/FILL") return send(200, api.fills);
  if (req.method === "POST" && path === "/orders") {
    if (body.limit_price === "1") return send(403, { code: 40310000, message: "insufficient buying power" });
    if (body.order_class === "bracket" && !(body.take_profit && body.stop_loss)) return send(422, { code: 42210000, message: "bracket needs both legs" });
    const o = {
      id: `ord-${++api.n}`, symbol: body.symbol, qty: body.qty, side: body.side, type: body.type,
      limit_price: body.limit_price ?? null, stop_price: body.stop_price ?? null,
      time_in_force: body.time_in_force, status: "new", submitted_at: new Date().toISOString(), legs: null,
    };
    const exit = body.side === "buy" ? "sell" : "buy";
    const legs = [];
    if (body.take_profit) legs.push({ id: `ord-${++api.n}`, parent: o.id, symbol: body.symbol, qty: body.qty, side: exit, type: "limit", limit_price: body.take_profit.limit_price, stop_price: null, status: "held" });
    if (body.stop_loss) legs.push({ id: `ord-${++api.n}`, parent: o.id, symbol: body.symbol, qty: body.qty, side: exit, type: "stop", limit_price: null, stop_price: body.stop_loss.stop_price, status: "held" });
    if (legs.length) o.legs = legs;
    api.orders.push(o, ...legs);
    const reply = structuredClone(o); // Alpaca answers with the order as submitted
    if (o.type === "market") fillOrder(o);
    return send(200, reply);
  }
  if (req.method === "DELETE" && path.startsWith("/orders/")) {
    const o = api.orders.find((x) => x.id === decodeURIComponent(path.slice(8)));
    if (!o) return send(404, { code: 40410000, message: "order not found" });
    if (!["new", "accepted", "held"].includes(o.status)) return send(422, { code: 42210000, message: "order is not cancelable" });
    o.status = "canceled";
    return send(204);
  }
  if (req.method === "DELETE" && path.startsWith("/positions/")) {
    const k = decodeURIComponent(path.slice(11));
    const p = api.positions[k];
    if (!p) return send(404, { code: 40410000, message: "position not found" });
    const sym = Object.keys(ASSETS).find((s) => posKey(s) === k);
    const o = { id: `ord-${++api.n}`, symbol: sym, qty: String(Math.abs(p.qty)), side: p.qty > 0 ? "sell" : "buy", type: "market", status: "new" };
    api.orders.push(o);
    fillOrder(o);
    return send(200, o);
  }
  send(404, { code: 40400000, message: `no mock for ${req.method} ${path}` });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${http.address().port}/v2`;

const startMcp = (env = {}) => start({
  TRADING_BROKER: "alpaca", ALPACA_BASE_URL: BASE, ALPACA_API_KEY_ID: "PKTEST", ALPACA_API_SECRET_KEY: "s3cret",
  TRADING_MAX_ORDER_QTY: "3", TRADING_MAX_POSITION: "5",
  ...env,
});
const orderPosts = () => api.requests.filter((q) => q.method === "POST" && q.path === "/orders");
async function place(m, o) {
  const p = data(await m.call("trade_preview_order", o));
  return data(await m.call("trade_confirm_order", { code: p.confirmationCode }));
}

await run("Trading MCP [alpaca] — end-to-end", async () => {
  const m = await startMcp();

  await step("tools labelled alpaca PAPER, symbol search available", async () => {
    const { tools } = await m.client.listTools();
    assert.ok(tools.some((t) => t.name === "trade_find_symbol"));
    assert.match(tools.find((t) => t.name === "trade_confirm_order").description, /\[alpaca PAPER\]/);
  });

  await step("status reads the paper account", async () => {
    const s = data(await m.call("trade_status"));
    assert.equal(s.mode, "alpaca PAPER");
    assert.equal(s.account, "PA3TEST");
    assert.equal(s.balance.equity, 100000);
    assert.equal(s.balance.buyingPower, 200000);
  });

  await step("find_symbol: known and unknown", async () => {
    assert.deepEqual(data(await m.call("trade_find_symbol", { text: "aapl" })), [{ symbol: "AAPL", description: "Apple Inc. (us_equity)" }]);
    assert.deepEqual(data(await m.call("trade_find_symbol", { text: "ZZZZ" })), []);
  });

  await step("symbol checks: TradingView prefix accepted, unknown / untradable refused", async () => {
    const p = data(await m.call("trade_preview_order", { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Market" }));
    assert.equal(p.order.symbol, "AAPL");
    err(await m.call("trade_preview_order", { symbol: "ZZZZ", action: "Buy", qty: 1, orderType: "Market" }), /Unknown symbol "ZZZZ"/);
    err(await m.call("trade_preview_order", { symbol: "OLD", action: "Buy", qty: 1, orderType: "Market" }), /not tradable/);
  });

  await step("fractional qty only where the asset allows it", async () => {
    data(await m.call("trade_preview_order", { symbol: "AAPL", action: "Buy", qty: 0.5, orderType: "Market" }));
    err(await m.call("trade_preview_order", { symbol: "GME", action: "Buy", qty: 0.5, orderType: "Market" }), /cannot be traded in fractions/);
  });

  await step("market order: exact Alpaca payload, position appears", async () => {
    const r = await place(m, { symbol: "AAPL", action: "Buy", qty: 2, orderType: "Market" });
    assert.equal(r.status, "new");
    const b = orderPosts().at(-1).body;
    assert.equal(b.symbol, "AAPL"); assert.equal(b.qty, "2"); assert.equal(b.side, "buy");
    assert.equal(b.type, "market"); assert.equal(b.time_in_force, "day");
    assert.match(b.client_order_id, /^mcp-/);
    assert.equal(b.order_class, undefined);
    assert.deepEqual(data(await m.call("trade_positions")), [{ symbol: "AAPL", qty: 2, avgPrice: 200, unrealizedPnl: 0 }]);
    assert.equal(data(await m.call("trade_fills"))[0].symbol, "AAPL");
  });

  let bracket;
  await step("limit + TP + SL is sent as order_class=bracket; legs returned", async () => {
    bracket = await place(m, { symbol: "AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 190, takeProfit: 210, stopLoss: 180, timeInForce: "GTC" });
    const b = orderPosts().at(-1).body;
    assert.equal(b.order_class, "bracket");
    assert.equal(b.type, "limit"); assert.equal(b.limit_price, "190"); assert.equal(b.time_in_force, "gtc");
    assert.deepEqual(b.take_profit, { limit_price: "210" });
    assert.deepEqual(b.stop_loss, { stop_price: "180" });
    assert.ok(bracket.takeProfitOrderId && bracket.stopLossOrderId);
  });

  await step("open orders include the bracket legs", async () => {
    const w = data(await m.call("trade_orders"));
    assert.deepEqual(w.map((o) => [o.orderType, o.price ?? o.stopPrice]).sort(), [["limit", 190], ["limit", 210], ["stop", 180]]);
  });

  await step("stop-loss only → order_class=oto", async () => {
    const r = await place(m, { symbol: "GME", action: "Sell", qty: 1, orderType: "Market", stopLoss: 30 });
    const b = orderPosts().at(-1).body;
    assert.equal(b.order_class, "oto");
    assert.equal(b.take_profit, undefined);
    assert.ok(r.stopLossOrderId);
    assert.equal((data(await m.call("trade_positions"))).find((p) => p.symbol === "GME").qty, -1);
  });

  await step("crypto: time_in_force forced to gtc, position keyed BTCUSD", async () => {
    await place(m, { symbol: "BTC/USD", action: "Buy", qty: 0.01, orderType: "Market" });
    const b = orderPosts().at(-1).body;
    assert.equal(b.symbol, "BTC/USD");
    assert.equal(b.time_in_force, "gtc");
    assert.equal((await data(await m.call("trade_positions"))).find((p) => p.symbol === "BTCUSD").qty, 0.01);
  });

  await step("qty limit and position limit use Alpaca positions", async () => {
    err(await m.call("trade_preview_order", { symbol: "AAPL", action: "Buy", qty: 4, orderType: "Market" }), /per-order limit of 3/);
    await place(m, { symbol: "AAPL", action: "Buy", qty: 3, orderType: "Market" });
    err(await m.call("trade_preview_order", { symbol: "AAPL", action: "Buy", qty: 1, orderType: "Market" }), /would become 6/);
  });

  await step("broker rejection (403 insufficient buying power) is reported + journalled", async () => {
    const p = data(await m.call("trade_preview_order", { symbol: "AAPL", action: "Sell", qty: 1, orderType: "Limit", price: 1 }));
    err(await m.call("trade_confirm_order", { code: p.confirmationCode }), /Order rejected: insufficient buying power/);
    const last = JSON.parse(readFileSync(m.journal, "utf-8").trim().split("\n").at(-1));
    assert.equal(last.event, "rejected");
    assert.equal(last.response.response.code, 40310000);
  });

  await step("cancel: 204 once, then 422 not cancelable", async () => {
    data(await m.call("trade_cancel_order", { orderId: bracket.orderId }));
    err(await m.call("trade_cancel_order", { orderId: bracket.orderId }), /Cancel failed: order is not cancelable/);
    err(await m.call("trade_cancel_order", { orderId: "nope" }), /Cancel failed: order not found/);
  });

  await step("close_position liquidates via DELETE /positions", async () => {
    const r = data(await m.call("trade_close_position", { symbol: "AAPL" }));
    assert.equal(r.previousQty, 5);
    assert.ok(api.requests.some((q) => q.method === "DELETE" && q.path === "/positions/AAPL"));
    assert.ok(!data(await m.call("trade_positions")).some((p) => p.symbol === "AAPL"));
    err(await m.call("trade_close_position", { symbol: "AAPL" }), /No open position/);
  });

  await step("live account without opt-in is read-only", async () => {
    const before = orderPosts().length;
    const l = await startMcp({ ALPACA_ENV: "live" });
    assert.equal(data(await l.call("trade_status")).mode, "alpaca LIVE (read-only)");
    err(await l.call("trade_preview_order", { symbol: "AAPL", action: "Buy", qty: 1, orderType: "Market" }), /Trading is disabled/);
    err(await l.call("trade_close_position", { symbol: "GME" }), /Trading is disabled/);
    assert.equal(orderPosts().length, before);
  });

  await step("missing / wrong keys give clear errors", async () => {
    const a = await startMcp({ ALPACA_API_KEY_ID: "" });
    err(await a.call("trade_status"), /Missing Alpaca API keys/);
    const b = await startMcp({ ALPACA_API_SECRET_KEY: "wrong" });
    err(await b.call("trade_status"), /Alpaca refused the API keys \(401\)/);
  });
}, () => http.close());
