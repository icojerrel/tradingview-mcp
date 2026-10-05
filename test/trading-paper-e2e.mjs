// End-to-end test of the trading MCP server with the built-in paper broker
// (TRADING_BROKER=paper). Prices come from a JSON file (TRADING_PAPER_PRICES_FILE)
// that the test rewrites to move the market, so fills are deterministic.
//
//   npm run build && node test/trading-paper-e2e.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startMcp as start, work, data, err, step, run } from "./helpers/mcp.mjs";

const pricesFile = join(work, "prices.json");
const prices = {
  "NASDAQ:AAPL": 200, "BINANCE:BTCUSDT": 60000, "NYSE:XOM": 100, "CME_MINI:MES1!": 6000, "NASDAQ:TSLA": 300,
};
const setPrice = (sym, p) => { prices[sym] = p; writeFileSync(pricesFile, JSON.stringify(prices)); };
setPrice("NASDAQ:AAPL", 200);

let stateN = 0;
const startMcp = (env = {}) => {
  const stateFile = join(work, `paper-${stateN++}.json`);
  return start({
    TRADING_BROKER: "paper",
    TRADING_PAPER_PRICES_FILE: pricesFile,
    TRADING_PAPER_STATE_FILE: stateFile,
    TRADING_MAX_ORDER_QTY: "5", TRADING_MAX_POSITION: "10",
    ...env,
  }).then((m) => ({ ...m, stateFile }));
};
const state = (m) => JSON.parse(readFileSync(m.stateFile, "utf-8"));
async function place(m, o) {
  const p = data(await m.call("trade_preview_order", o));
  return data(await m.call("trade_confirm_order", { code: p.confirmationCode }));
}
const pos = async (m, sym) => data(await m.call("trade_positions")).find((p) => p.symbol === sym);

await run("Trading MCP [paper] — end-to-end", async () => {
  const m = await startMcp();

  await step("tools are labelled PAPER (simulated), no symbol search", async () => {
    const { tools } = await m.client.listTools();
    assert.ok(!tools.some((t) => t.name === "trade_find_symbol"));
    assert.match(tools.find((t) => t.name === "trade_confirm_order").description, /\[PAPER \(simulated\)\]/);
    assert.match(tools.find((t) => t.name === "trade_preview_order").inputSchema.properties.symbol.description, /EXCHANGE:TICKER/);
  });

  await step("fresh account: 100k equity, trading enabled", async () => {
    const s = data(await m.call("trade_status"));
    assert.equal(s.account, "PAPER");
    assert.equal(s.tradingEnabled, true);
    assert.deepEqual(s.balance, { startCash: 100000, realizedPnl: 0, unrealizedPnl: 0, equity: 100000 });
  });

  await step("symbol checks: format and known price", async () => {
    err(await m.call("trade_preview_order", { symbol: "AAPL", action: "Buy", qty: 1, orderType: "Market" }), /EXCHANGE:TICKER/);
    err(await m.call("trade_preview_order", { symbol: "NASDAQ:NOPE", action: "Buy", qty: 1, orderType: "Market" }), /No price for NASDAQ:NOPE/);
  });

  await step("market buy fills at the last price", async () => {
    const r = await place(m, { symbol: "nasdaq:aapl", action: "Buy", qty: 2, orderType: "Market" });
    assert.equal(r.status, "Filled");
    assert.equal(r.fillPrice, 200);
    assert.deepEqual(await pos(m, "NASDAQ:AAPL"), { symbol: "NASDAQ:AAPL", qty: 2, avgPrice: 200, lastPrice: 200, unrealizedPnl: 0 });
  });

  await step("unrealized P&L follows the price", async () => {
    setPrice("NASDAQ:AAPL", 210);
    assert.equal((await pos(m, "NASDAQ:AAPL")).unrealizedPnl, 20);
    assert.equal(data(await m.call("trade_status")).balance.equity, 100020);
  });

  let limitId;
  await step("limit sell waits, then fills at the LIMIT price (not the last)", async () => {
    const r = await place(m, { symbol: "NASDAQ:AAPL", action: "Sell", qty: 1, orderType: "Limit", price: 220, timeInForce: "GTC" });
    assert.equal(r.status, "Working");
    limitId = r.orderId;
    setPrice("NASDAQ:AAPL", 215);
    assert.equal(data(await m.call("trade_orders")).length, 1);
    setPrice("NASDAQ:AAPL", 221);
    assert.equal(data(await m.call("trade_orders")).length, 0);
    const f = data(await m.call("trade_fills")).find((x) => x.orderId === limitId);
    assert.equal(f.price, 220);
    assert.equal(data(await m.call("trade_status")).balance.realizedPnl, 20);
  });

  await step("marketable limit fills immediately at the better last price", async () => {
    setPrice("NASDAQ:AAPL", 210);
    const r = await place(m, { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 215 });
    assert.equal(r.fillPrice, 210);
    const p = await pos(m, "NASDAQ:AAPL");
    assert.equal(p.qty, 2);
    assert.equal(p.avgPrice, 205); // (200 + 210) / 2
  });

  await step("stop sell triggers and fills at the last price", async () => {
    const r = await place(m, { symbol: "NASDAQ:AAPL", action: "Sell", qty: 2, orderType: "Stop", stopPrice: 205 });
    assert.equal(r.status, "Working");
    setPrice("NASDAQ:AAPL", 204);
    assert.equal(await pos(m, "NASDAQ:AAPL"), undefined);
    assert.equal(data(await m.call("trade_fills")).at(-1).price, 204);
    // realized: +20 earlier, now (204-205)*2 = -2
    assert.equal(data(await m.call("trade_status")).balance.realizedPnl, 18);
  });

  await step("bracket: stop-loss hit cancels the take-profit (OCO), fractional qty", async () => {
    const r = await place(m, { symbol: "BINANCE:BTCUSDT", action: "Buy", qty: 0.5, orderType: "Market", takeProfit: 63000, stopLoss: 58000 });
    assert.ok(r.takeProfitOrderId && r.stopLossOrderId);
    let w = data(await m.call("trade_orders"));
    assert.deepEqual(w.map((o) => o.orderType).sort(), ["Limit", "Stop"]);
    setPrice("BINANCE:BTCUSDT", 58500);
    assert.equal(data(await m.call("trade_orders")).length, 2);
    setPrice("BINANCE:BTCUSDT", 57900);
    assert.equal(data(await m.call("trade_orders")).length, 0);
    const s = state(m);
    assert.equal(s.orders.find((o) => o.id === r.takeProfitOrderId).status, "Canceled");
    assert.equal(s.orders.find((o) => o.id === r.stopLossOrderId).fillPrice, 57900);
    assert.equal(await pos(m, "BINANCE:BTCUSDT"), undefined);
    assert.equal(data(await m.call("trade_status")).balance.realizedPnl, 18 - 1050);
  });

  await step("short, then flip to long: avg resets to the fill price", async () => {
    await place(m, { symbol: "NYSE:XOM", action: "Sell", qty: 1, orderType: "Market" });
    assert.equal((await pos(m, "NYSE:XOM")).qty, -1);
    setPrice("NYSE:XOM", 90);
    await place(m, { symbol: "NYSE:XOM", action: "Buy", qty: 3, orderType: "Market" });
    const p = await pos(m, "NYSE:XOM");
    assert.deepEqual([p.qty, p.avgPrice], [2, 90]);
    assert.equal(data(await m.call("trade_status")).balance.realizedPnl, 18 - 1050 + 10);
  });

  await step("stop-limit: triggers, then waits for its limit", async () => {
    setPrice("NASDAQ:TSLA", 99);
    const r = await place(m, { symbol: "NASDAQ:TSLA", action: "Buy", qty: 1, orderType: "StopLimit", stopPrice: 100, price: 101 });
    assert.equal(r.status, "Working");
    setPrice("NASDAQ:TSLA", 102); // stop hit, but above the limit
    assert.equal(data(await m.call("trade_orders"))[0].orderType, "Limit (stop triggered)");
    setPrice("NASDAQ:TSLA", 100.5);
    assert.equal(data(await m.call("trade_fills")).at(-1).price, 101);
  });

  await step("close_position flattens and cancels attached exits", async () => {
    setPrice("NYSE:XOM", 95);
    await place(m, { symbol: "NYSE:XOM", action: "Buy", qty: 1, orderType: "Market", stopLoss: 80 });
    assert.equal(data(await m.call("trade_orders")).length, 1);
    const r = data(await m.call("trade_close_position", { symbol: "NYSE:XOM" }));
    assert.equal(r.previousQty, 3);
    assert.equal(r.fillPrice, 95);
    assert.equal(await pos(m, "NYSE:XOM"), undefined);
    assert.equal(data(await m.call("trade_orders")).length, 0);
    err(await m.call("trade_close_position", { symbol: "NYSE:XOM" }), /No open position/);
  });

  await step("cancel: works once, unknown ids are refused", async () => {
    const r = await place(m, { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 150, timeInForce: "GTC" });
    data(await m.call("trade_cancel_order", { orderId: r.orderId }));
    err(await m.call("trade_cancel_order", { orderId: r.orderId }), /Cancel failed: .*not working/);
    err(await m.call("trade_cancel_order", { orderId: "P999" }), /Cancel failed: Unknown order/);
  });

  await step("Day orders expire on a new day, GTC orders do not", async () => {
    const day = await place(m, { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 150 });
    const gtc = await place(m, { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 151, timeInForce: "GTC" });
    const s = state(m);
    for (const o of s.orders) if (o.id === day.orderId || o.id === gtc.orderId) o.placed = "2020-01-01T15:00:00.000Z";
    writeFileSync(m.stateFile, JSON.stringify(s));
    const ids = data(await m.call("trade_orders")).map((o) => o.orderId);
    assert.deepEqual(ids, [gtc.orderId]);
    assert.equal(state(m).orders.find((o) => o.id === day.orderId).status, "Expired");
    data(await m.call("trade_cancel_order", { orderId: gtc.orderId }));
  });

  await step("risk limits apply to paper too", async () => {
    err(await m.call("trade_preview_order", { symbol: "NASDAQ:AAPL", action: "Buy", qty: 6, orderType: "Market" }), /per-order limit of 5/);
  });

  await step("account survives a server restart (state file)", async () => {
    const before = data(await m.call("trade_status")).balance;
    const m2 = await start({
      TRADING_BROKER: "paper", TRADING_PAPER_PRICES_FILE: pricesFile, TRADING_PAPER_STATE_FILE: m.stateFile,
    });
    assert.deepEqual(data(await m2.call("trade_status")).balance, before);
  });

  await step("futures point value multiplies P&L", async () => {
    const f = await startMcp({ TRADING_PAPER_POINT_VALUES: "CME_MINI:MES1!=5" });
    await place(f, { symbol: "CME_MINI:MES1!", action: "Buy", qty: 1, orderType: "Market" });
    setPrice("CME_MINI:MES1!", 6010);
    assert.equal((await pos(f, "CME_MINI:MES1!")).unrealizedPnl, 50);
    const st = data(await f.call("trade_status")).balance;
    assert.equal(st.equity, 100050);
  });

  await step("background price check fills orders without any tool call", async () => {
    setPrice("NASDAQ:AAPL", 200);
    const b = await startMcp({ TRADING_PAPER_POLL_SEC: "1" });
    await place(b, { symbol: "NASDAQ:AAPL", action: "Buy", qty: 1, orderType: "Limit", price: 190 });
    setPrice("NASDAQ:AAPL", 189);
    await new Promise((r) => setTimeout(r, 2500));
    const o = state(b).orders[0]; // read the file directly: no tool call in between
    assert.equal(o.status, "Filled");
    assert.equal(o.fillPrice, 190);
  });
});
