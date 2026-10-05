// End-to-end test of the trading MCP server with TRADING_BROKER=tradovate.
//
// Runs a local stand-in for the Tradovate REST API (same paths, payloads and
// quirks: access tokens, p-ticket penalty, failureReason responses), points the
// server at it with TRADOVATE_BASE_URL and drives every tool over stdio.
//
//   npm run build && node test/trading-tradovate-e2e.mjs

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { startMcp as start, data, err, step, run } from "./helpers/mcp.mjs";

// ── Mock Tradovate API ──────────────────────────────────────────────────────
const CONTRACTS = [
  { id: 100, name: "MESZ6" }, { id: 101, name: "MNQZ6" }, { id: 102, name: "ESZ6" }, { id: 103, name: "MESH7" },
];
let api;
function resetApi(opts = {}) {
  api = {
    opts: { penaltyOnce: false, tokenTtlMs: 90 * 60 * 1000, ...opts },
    penaltyGiven: false,
    logins: 0, renewals: 0,
    tokens: new Set(),
    requests: [],
    positions: [], // { accountId, contractId, netPos, netPrice }
    orders: [],    // { id, accountId, contractId, action, ordStatus, timestamp, version }
    fills: [],
    nextId: 5000,
  };
}
resetApi();

const LAST = { 100: 6000, 101: 21000, 102: 6000, 103: 6050 };
function fill(accountId, contractId, action, qty, price) {
  let p = api.positions.find((x) => x.accountId === accountId && x.contractId === contractId);
  if (!p) api.positions.push(p = { accountId, contractId, netPos: 0, netPrice: price });
  p.netPos += action === "Buy" ? qty : -qty;
  p.netPrice = price;
}
function newOrder(accountId, body, status) {
  const c = CONTRACTS.find((x) => x.name === body.symbol);
  const o = {
    id: api.nextId++, accountId, contractId: c.id, action: body.action, ordStatus: status,
    timestamp: new Date().toISOString(),
    version: { orderQty: body.orderQty, orderType: body.orderType, price: body.price, stopPrice: body.stopPrice },
  };
  api.orders.push(o);
  if (status === "Filled") {
    fill(accountId, c.id, body.action, body.orderQty, LAST[c.id]);
    api.fills.push({ orderId: o.id, contractId: c.id, action: body.action, qty: body.orderQty, price: LAST[c.id], timestamp: o.timestamp });
  }
  return o;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/v1/, "");
  let body = null;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
  api.requests.push({ method: req.method, path, body });
  const send = (code, data) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));

  if (path === "/auth/accesstokenrequest") {
    if (api.opts.penaltyOnce && !api.penaltyGiven) {
      api.penaltyGiven = true;
      return send(200, { "p-ticket": "TICKET1", "p-time": 1 });
    }
    if (api.opts.penaltyOnce && body["p-ticket"] !== "TICKET1") return send(200, { errorText: "missing p-ticket" });
    if (body.name !== "demo-user" || body.password !== "pw" || body.cid !== "42" || body.sec !== "secret") {
      return send(200, { errorText: "Incorrect username or password" });
    }
    api.logins++;
    const t = `tok-${api.logins}`;
    api.tokens.add(t);
    return send(200, { accessToken: t, expirationTime: new Date(Date.now() + api.opts.tokenTtlMs).toISOString(), userId: 7 });
  }

  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  if (!api.tokens.has(token)) return send(401, { errorText: "Access is denied" });

  if (path === "/auth/renewaccesstoken") {
    api.renewals++;
    const t = `tok-renew-${api.renewals}`;
    api.tokens.add(t);
    return send(200, { accessToken: t, expirationTime: new Date(Date.now() + 90 * 60 * 1000).toISOString() });
  }
  if (path === "/account/list") {
    return send(200, [{ id: 1, name: "DEMO111", active: true }, { id: 2, name: "DEMO222", active: true }]);
  }
  if (path === "/cashBalance/getcashbalancesnapshot") {
    return send(200, { accountId: body.accountId, totalCashValue: 50000, realizedPnL: 0, openPnL: 0 });
  }
  if (path === "/contract/find") {
    return send(200, CONTRACTS.find((c) => c.name === url.searchParams.get("name")) ?? null);
  }
  if (path === "/contract/item") {
    return send(200, CONTRACTS.find((c) => c.id === Number(url.searchParams.get("id"))) ?? null);
  }
  if (path === "/contract/suggest") {
    return send(200, CONTRACTS.filter((c) => c.name.startsWith(url.searchParams.get("t"))));
  }
  if (path === "/position/list") return send(200, api.positions);
  if (path === "/order/list") return send(200, api.orders.map(({ version, ...o }) => o));
  if (path === "/orderVersion/deps") {
    const o = api.orders.find((x) => x.id === Number(url.searchParams.get("masterid")));
    return send(200, o ? [{ orderId: o.id, ...o.version }] : []);
  }
  if (path === "/fill/list") return send(200, api.fills);

  if (path === "/order/placeorder" || path === "/order/placeOSO") {
    const acc = [1, 2].includes(body.accountId) ? body.accountId : null;
    if (!acc || body.isAutomated !== true) return send(200, { failureReason: "InvalidRequest", failureText: "bad account or not automated" });
    if (body.price === 1) return send(200, { failureReason: "UnknownReason", failureText: "Price out of range" });
    const entry = newOrder(acc, body, body.orderType === "Market" ? "Filled" : "Working");
    const out = { orderId: entry.id };
    for (const [key, outKey] of [["bracket1", "oso1Id"], ["bracket2", "oso2Id"]]) {
      if (body[key]) out[outKey] = newOrder(acc, { ...body[key], symbol: body.symbol, orderQty: body.orderQty }, "Working").id;
    }
    return send(200, out);
  }
  if (path === "/order/cancelorder") {
    const o = api.orders.find((x) => x.id === body.orderId);
    if (!o || o.ordStatus !== "Working") return send(200, { failureReason: "TooLate", failureText: "Order is not working" });
    o.ordStatus = "Canceled";
    return send(200, { orderId: o.id });
  }
  if (path === "/order/liquidateposition") {
    const p = api.positions.find((x) => x.accountId === body.accountId && x.contractId === body.contractId);
    const o = newOrder(body.accountId, { symbol: CONTRACTS.find((c) => c.id === body.contractId).name, action: p.netPos > 0 ? "Sell" : "Buy", orderQty: Math.abs(p.netPos), orderType: "Market" }, "Filled");
    return send(200, { orderId: o.id });
  }
  send(404, { errorText: `no mock for ${path}` });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${http.address().port}/v1`;

const startMcp = (env = {}) => start({
  TRADING_BROKER: "tradovate",
  TRADOVATE_BASE_URL: BASE,
  TRADOVATE_USERNAME: "demo-user", TRADOVATE_PASSWORD: "pw", TRADOVATE_CID: "42", TRADOVATE_SEC: "secret",
  ...env,
});
const placed = () => api.requests.filter((q) => q.path === "/order/placeorder" || q.path === "/order/placeOSO");

await run("Trading MCP [tradovate] — end-to-end", async () => {
  const m = await startMcp({ TRADING_MAX_ORDER_QTY: "2", TRADING_MAX_POSITION: "3", TRADING_MAX_ORDERS_PER_DAY: "5" });
  
  await step("lists all tools, labelled DEMO", async () => {
    const { tools } = await m.client.listTools();
    assert.equal(tools.length, 9);
    assert.match(tools.find((t) => t.name === "trade_preview_order").description, /tradovate PAPER/);
  });

  await step("status logs in once and reports demo account + limits", async () => {
    const s = data(await m.call("trade_status"));
    assert.equal(s.mode, "tradovate PAPER");
    assert.equal(s.tradingEnabled, true);
    assert.equal(s.account, "DEMO111");
    assert.equal(s.balance.totalCashValue, 50000);
    assert.deepEqual(s.limits, { maxOrderQty: 2, maxPosition: 3, maxOrdersPerDay: 5, allowedProducts: null });
    data(await m.call("trade_positions"));
    assert.equal(api.logins, 1, "token should be reused");
  });

  await step("find_contract suggests contracts", async () => {
    assert.deepEqual(data(await m.call("trade_find_symbol", { text: "MES" })).map((c) => c.symbol), ["MESZ6", "MESH7"]);
  });

  let code;
  await step("preview validates but sends NOTHING", async () => {
    const before = placed().length;
    const p = data(await m.call("trade_preview_order", { symbol: "mesz6", action: "Buy", qty: 1, orderType: "Market" }));
    assert.match(p.confirmationCode, /^\d{6}$/);
    assert.equal(p.summary, "BUY 1 MESZ6 MARKET (Day)");
    assert.equal(p.positionAfterFill, 1);
    assert.equal(placed().length, before);
    code = p.confirmationCode;
  });

  await step("confirm places the order (isAutomated, right account) and journals it", async () => {
    const r = data(await m.call("trade_confirm_order", { code }));
    assert.equal(r.placed, true);
    const body = placed().at(-1).body;
    assert.equal(body.accountSpec, "DEMO111");
    assert.equal(body.accountId, 1);
    assert.equal(body.isAutomated, true);
    assert.equal(body.symbol, "MESZ6");
    const lines = readFileSync(m.journal, "utf-8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.at(-1).event, "placed");
    assert.equal(String(lines.at(-1).response.response.orderId), r.orderId);
  });

  await step("confirmation code is single use", async () => {
    err(await m.call("trade_confirm_order", { code }), /Unknown or expired/);
    err(await m.call("trade_confirm_order", { code: "000000" }), /Unknown or expired/);
  });

  await step("positions + fills show the filled order", async () => {
    assert.deepEqual(data(await m.call("trade_positions")), [{ symbol: "MESZ6", qty: 1, avgPrice: 6000 }]);
    const f = data(await m.call("trade_fills"));
    assert.equal(f.length, 1);
    assert.equal(f[0].symbol, "MESZ6");
  });

  await step("per-order quantity limit", async () => {
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 3, orderType: "Market" }), /exceeds the per-order limit of 2/);
  });

  await step("position limit blocks growing past ±3, allows reducing", async () => {
    // current +1; buying 2 → 3 ok; then +1 more would be 4
    const p = data(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 2, orderType: "Market" }));
    data(await m.call("trade_confirm_order", { code: p.confirmationCode }));
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Market" }), /would become 4/);
    const red = data(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Sell", qty: 2, orderType: "Market" }));
    assert.equal(red.positionAfterFill, 1);
  });

  await step("limits are re-checked at confirm time", async () => {
    // Preview a buy of 0→? on MNQZ6 twice; confirming both would exceed ±3
    const a = data(await m.call("trade_preview_order", { symbol: "MNQZ6", action: "Sell", qty: 2, orderType: "Market" }));
    const b = data(await m.call("trade_preview_order", { symbol: "MNQZ6", action: "Sell", qty: 2, orderType: "Market" }));
    data(await m.call("trade_confirm_order", { code: a.confirmationCode }));
    err(await m.call("trade_confirm_order", { code: b.confirmationCode }), /would become -4/);
  });

  await step("order shape validation", async () => {
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Limit" }), /need a price/);
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Market", price: 5 }), /take no price/);
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Stop" }), /need a stopPrice/);
    err(await m.call("trade_preview_order", { symbol: "XYZ", action: "Buy", qty: 1, orderType: "Market" }), /Unknown contract/);
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 0, orderType: "Market" }), /too_small|>=1|greater than or equal/i);
  });

  await step("bracket validation (wrong side of entry)", async () => {
    err(await m.call("trade_preview_order", { symbol: "ESZ6", action: "Buy", qty: 1, orderType: "Limit", price: 6000, takeProfit: 5990, stopLoss: 5980 }), /takeProfit 5990 is on the wrong side/);
    err(await m.call("trade_preview_order", { symbol: "ESZ6", action: "Sell", qty: 1, orderType: "Market", takeProfit: 6100, stopLoss: 6050 }), /must be below stopLoss/);
  });

  let limitIds;
  await step("limit order with bracket goes through placeOSO", async () => {
    const p = data(await m.call("trade_preview_order", { symbol: "ESZ6", action: "Buy", qty: 1, orderType: "Limit", price: 5900, takeProfit: 5950, stopLoss: 5880, timeInForce: "GTC" }));
    assert.equal(p.summary, "BUY 1 ESZ6 LIMIT @ 5900 (GTC), take profit 5950, stop loss 5880");
    const r = data(await m.call("trade_confirm_order", { code: p.confirmationCode }));
    const q = placed().at(-1);
    assert.equal(q.path, "/order/placeOSO");
    assert.deepEqual(q.body.bracket1, { action: "Sell", orderType: "Limit", price: 5950 });
    assert.deepEqual(q.body.bracket2, { action: "Sell", orderType: "Stop", stopPrice: 5880 });
    assert.ok(r.takeProfitOrderId && r.stopLossOrderId);
    limitIds = r;
  });

  await step("stop-loss-only bracket uses bracket1", async () => {
    const p = data(await m.call("trade_preview_order", { symbol: "MESH7", action: "Sell", qty: 1, orderType: "Market", stopLoss: 6100 }));
    const r = data(await m.call("trade_confirm_order", { code: p.confirmationCode }));
    assert.deepEqual(placed().at(-1).body.bracket1, { action: "Buy", orderType: "Stop", stopPrice: 6100 });
    assert.ok(r.stopLossOrderId);
    assert.equal(r.takeProfitOrderId, undefined);
  });

  await step("working orders list shows qty and prices", async () => {
    const w = data(await m.call("trade_orders"));
    const entry = w.find((o) => o.orderId === limitIds.orderId);
    assert.deepEqual({ symbol: entry.symbol, qty: entry.qty, orderType: entry.orderType, price: entry.price }, { symbol: "ESZ6", qty: 1, orderType: "Limit", price: 5900 });
  });

  await step("cancel works, cancelling twice reports the failure", async () => {
    data(await m.call("trade_cancel_order", { orderId: limitIds.orderId }));
    err(await m.call("trade_cancel_order", { orderId: limitIds.orderId }), /not working/);
  });

  await step("daily order limit (5) is enforced from the journal", async () => {
    // placed so far: 1 + 1 + 1 (MNQ) + 1 (ES OSO) + 1 (MES H7) = 5
    err(await m.call("trade_preview_order", { symbol: "MESZ6", action: "Sell", qty: 1, orderType: "Market" }), /Daily order limit reached \(5\/5/);
  });

  await step("close_position flattens", async () => {
    const r = data(await m.call("trade_close_position", { symbol: "MESZ6" }));
    assert.equal(r.previousQty, 3);
    assert.ok(!data(await m.call("trade_positions")).some((p) => p.symbol === "MESZ6"));
    err(await m.call("trade_close_position", { symbol: "MESZ6" }), /No open position/);
  });

  await step("exchange rejection is reported and journalled", async () => {
    const m2 = await startMcp();
    const p = data(await m2.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Limit", price: 1 }));
    err(await m2.call("trade_confirm_order", { code: p.confirmationCode }), /Order rejected: Price out of range/);
    const last = JSON.parse(readFileSync(m2.journal, "utf-8").trim().split("\n").at(-1));
    assert.equal(last.event, "rejected");
  });

  await step("allowed products filter", async () => {
    const m3 = await startMcp({ TRADING_ALLOWED_PRODUCTS: "MES, MNQ" });
    data(await m3.call("trade_preview_order", { symbol: "MNQZ6", action: "Buy", qty: 1, orderType: "Market" }));
    err(await m3.call("trade_preview_order", { symbol: "ESZ6", action: "Buy", qty: 1, orderType: "Market" }), /Product ES is not allowed/);
  });

  await step("TRADOVATE_ACCOUNT selects the second account", async () => {
    const m4 = await startMcp({ TRADOVATE_ACCOUNT: "DEMO222" });
    assert.equal(data(await m4.call("trade_status")).account, "DEMO222");
    const m5 = await startMcp({ TRADOVATE_ACCOUNT: "NOPE" });
    err(await m5.call("trade_status"), /Account "NOPE" not found. Available: DEMO111, DEMO222/);
  });

  await step("confirmation code expires", async () => {
    const m6 = await startMcp({ TRADING_CONFIRM_TTL_SEC: "1" });
    const p = data(await m6.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Market" }));
    await new Promise((r) => setTimeout(r, 1200));
    err(await m6.call("trade_confirm_order", { code: p.confirmationCode }), /Unknown or expired/);
  });

  await step("LIVE without opt-in is read-only (no order request sent)", async () => {
    const before = placed().length;
    const m7 = await startMcp({ TRADOVATE_ENV: "live" });
    const { tools } = await m7.client.listTools();
    assert.match(tools.find((t) => t.name === "trade_confirm_order").description, /\[tradovate LIVE \(read-only\)\]/);
    const s = data(await m7.call("trade_status"));
    assert.equal(s.mode, "tradovate LIVE (read-only)");
    assert.equal(s.tradingEnabled, false);
    for (const [tool, args] of [
      ["trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Market" }],
      ["trade_confirm_order", { code: "123456" }],
      ["trade_cancel_order", { orderId: 1 }],
      ["trade_close_position", { symbol: "MNQZ6" }],
    ]) err(await m7.call(tool, args), /Trading is disabled/);
    assert.equal(placed().length, before);
    assert.ok(!api.requests.some((q) => q.path === "/order/liquidateposition" && q.body.contractId === 101));
  });

  await step("LIVE with TRADING_LIVE_TRADING=1 is labelled LIVE and can trade", async () => {
    const m8 = await startMcp({ TRADOVATE_ENV: "live", TRADING_LIVE_TRADING: "1" });
    const { tools } = await m8.client.listTools();
    assert.match(tools.find((t) => t.name === "trade_preview_order").description, /\[tradovate LIVE\]/);
    const p = data(await m8.call("trade_preview_order", { symbol: "MESZ6", action: "Buy", qty: 1, orderType: "Market" }));
    assert.equal(p.mode, "tradovate LIVE");
  });

  await step("p-ticket rate-limit penalty is waited out and retried", async () => {
    resetApi({ penaltyOnce: true });
    const m9 = await startMcp();
    const t0 = Date.now();
    assert.equal(data(await m9.call("trade_status")).account, "DEMO111");
    assert.ok(Date.now() - t0 >= 900, "should wait p-time");
    assert.equal(api.logins, 1);
  });

  await step("token close to expiry is renewed instead of a new login", async () => {
    resetApi({ tokenTtlMs: 5 * 60 * 1000 }); // < 10 min margin → renew on next call
    const m10 = await startMcp();
    data(await m10.call("trade_status"));
    data(await m10.call("trade_positions"));
    assert.equal(api.logins, 1);
    assert.ok(api.renewals >= 1);
  });

  await step("bad / missing credentials give clear errors", async () => {
    const m11 = await startMcp({ TRADOVATE_PASSWORD: "wrong" });
    err(await m11.call("trade_status"), /Incorrect username or password/);
    const m12 = await startMcp({ TRADOVATE_CID: "", TRADOVATE_SEC: "" });
    err(await m12.call("trade_status"), /Missing Tradovate credentials: TRADOVATE_CID, TRADOVATE_SEC/);
  });

}, () => http.close());
