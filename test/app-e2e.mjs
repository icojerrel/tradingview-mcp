// End-to-end test for the TradingView app MCP server (dist/app/index.js).
//
// Starts a real Chromium with --remote-debugging-port (standing in for the
// TradingView Desktop app), opens test/fixtures/mock-chart.html on /chart/,
// then drives the MCP server over stdio exactly like Claude would, and checks
// the resulting chart state inside the page.
//
//   npm run build && node test/app-e2e.mjs
//
// CHROME_PATH overrides the browser binary (default: Playwright's Chromium).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "test/fixtures/mock-chart.html"));
const CDP_PORT = 9333;
const SCREENSHOT_OUT = process.env.SCREENSHOT_OUT ?? join(tmpdir(), "tv-app-e2e.png");

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack ?? err}`);
    throw err;
  }
}

// ── Fixture server + browser ────────────────────────────────────────────────
const http = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end(html);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const chartUrl = `http://127.0.0.1:${http.address().port}/chart/abc123/`;

const profile = mkdtempSync(join(tmpdir(), "tv-e2e-"));
const browserProc = spawn(process.env.CHROME_PATH ?? chromium.executablePath(), [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1400,800", chartUrl,
], { stdio: "ignore" });

async function waitForCdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chromium did not open the debugging port");
}

function startMcp(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/app/index.js")],
    env: {
      ...process.env,
      TV_CDP_URL: `http://127.0.0.1:${CDP_PORT}`,
      TV_APP_URL_MATCH: "127\\.0\\.0\\.1:\\d+/chart",
      TV_APP_READY_TIMEOUT_MS: "10000",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  return client.connect(transport).then(() => client);
}

const text = (res) => res.content[0].text;
const data = (res) => {
  assert.ok(!res.isError, `tool returned error: ${text(res)}`);
  return JSON.parse(text(res));
};

let client;
try {
  await waitForCdp();
  client = await startMcp({ TV_APP_ALLOW_EVAL: "1" });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const mock = async () => data(await call("app_evaluate", { code: "return window.__mockState" }));

  console.log("TradingView app MCP — end-to-end");

  await step("lists all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["app_status", "chart_set_symbol", "chart_set_timeframe", "indicator_add",
      "drawing_create", "chart_screenshot", "chart_get_bars", "app_press_keys", "app_evaluate"]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });

  await step("app_status attaches over CDP and reads the chart", async () => {
    const s = data(await call("app_status"));
    assert.equal(s.connection.mode, "cdp");
    assert.equal(s.chart.symbol, "NASDAQ:AAPL");
    assert.equal(s.chart.resolution, "1D");
    assert.equal(s.chart.chartType, "candles");
    assert.ok(s.chart.url.includes("/chart/abc123/"));
  });

  await step("chart_set_symbol changes the symbol in the app", async () => {
    const s = data(await call("chart_set_symbol", { symbol: "BINANCE:BTCUSDT" }));
    assert.equal(s.symbol, "BINANCE:BTCUSDT");
    assert.equal((await mock()).symbol, "BINANCE:BTCUSDT");
  });

  await step("chart_set_timeframe maps 4h → 240", async () => {
    const s = data(await call("chart_set_timeframe", { timeframe: "4h" }));
    assert.equal(s.resolution, "240");
    assert.equal((await mock()).resolution, "240");
  });

  await step("chart_set_timeframe rejects nonsense", async () => {
    const res = await call("chart_set_timeframe", { timeframe: "banana" });
    assert.ok(res.isError);
    assert.match(text(res), /Unknown timeframe/);
  });

  await step("chart_set_type switches to heikin_ashi", async () => {
    const s = data(await call("chart_set_type", { type: "heikin_ashi" }));
    assert.equal(s.chartType, "heikin_ashi");
    assert.equal((await mock()).chartType, 8);
    data(await call("chart_set_type", { type: "candles" }));
  });

  let rsiId;
  await step("indicator_add adds RSI with custom length", async () => {
    const r = data(await call("indicator_add", { name: "Relative Strength Index", inputs: { length: 21 } }));
    rsiId = r.id;
    assert.equal(r.name, "Relative Strength Index");
    const st = (await mock()).studies.find((s) => s.id === rsiId);
    assert.equal(st.inputs.length, 21);
  });

  await step("indicator_add reports unknown indicator names", async () => {
    const res = await call("indicator_add", { name: "Does Not Exist" });
    assert.ok(res.isError);
    assert.match(text(res), /did not add/);
  });

  await step("indicator_update + indicator_get change inputs and visibility", async () => {
    const r = data(await call("indicator_update", { id: rsiId, inputs: { length: 7 }, visible: false }));
    assert.deepEqual(r.inputs, [{ id: "length", value: 7 }]);
    assert.equal(r.visible, false);
    assert.equal(data(await call("indicator_get", { id: rsiId })).visible, false);
  });

  let lineId;
  await step("drawing_create draws a horizontal line (1 point, default time)", async () => {
    const r = data(await call("drawing_create", { shape: "horizontal_line", points: [{ price: 50000 }] }));
    lineId = r.id;
    const sh = (await mock()).shapes.find((s) => s.id === lineId);
    assert.equal(sh.points[0].price, 50000);
    assert.ok(sh.points[0].time > 0);
  });

  await step("drawing_create draws a trend line (2 points)", async () => {
    const r = data(await call("drawing_create", {
      shape: "trend_line",
      points: [{ time: 1760000000, price: 100 }, { time: 1760500000, price: 120 }],
    }));
    assert.equal(r.drawings.length, 2);
  });

  await step("drawing_create reports invalid shapes", async () => {
    const res = await call("drawing_create", { shape: "trend_line", points: [{ price: 1 }] });
    assert.ok(res.isError);
    assert.match(text(res), /did not create/);
  });

  await step("chart_get_bars returns OHLCV", async () => {
    const r = data(await call("chart_get_bars", { count: 5 }));
    assert.equal(r.bars.length, 5);
    const b = r.bars[4];
    for (const k of ["time", "open", "high", "low", "close", "volume"]) assert.equal(typeof b[k], "number", k);
    assert.ok(b.high >= b.low);
  });

  await step("chart_set_visible_range zooms", async () => {
    const s = data(await call("chart_set_visible_range", { from: 1767000000, to: 1767225600 }));
    assert.deepEqual(s.visibleRange, { from: 1767000000, to: 1767225600 });
  });

  await step("chart_execute_action runs an action id", async () => {
    data(await call("chart_execute_action", { actionId: "chartReset" }));
    assert.ok((await mock()).actions.includes("chartReset"));
  });

  await step("app_press_keys reaches the page", async () => {
    data(await call("app_press_keys", { keys: ["Alt+H"] }));
    assert.ok((await mock()).actions.includes("key:Alt+H"));
  });

  await step("chart_screenshot returns a PNG of the chart", async () => {
    const res = await call("chart_screenshot");
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.content[0].type, "image");
    const png = Buffer.from(res.content[0].data, "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(png.length > 5000, "screenshot suspiciously small");
    writeFileSync(SCREENSHOT_OUT, png);
  });

  await step("indicator_remove + drawing_remove clean up", async () => {
    data(await call("indicator_remove", { id: rsiId }));
    data(await call("drawing_remove", { ids: [lineId] }));
    assert.equal((await mock()).shapes.length, 1);
    const bad = await call("drawing_remove", { ids: ["nope"] });
    assert.ok(bad.isError);
    data(await call("drawing_remove"));
    const m = await mock();
    assert.equal(m.studies.length, 0);
    assert.equal(m.shapes.length, 0);
  });

  await step("app_reconnect reattaches", async () => {
    const s = data(await call("app_reconnect"));
    assert.equal(s.chart.symbol, "BINANCE:BTCUSDT");
  });

  await client.close();
  client = null;

  await step("closing the MCP server leaves the app running", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const pages = await r.json();
    assert.ok(pages.some((p) => p.url === chartUrl));
  });

  await step("app_evaluate is not exposed without TV_APP_ALLOW_EVAL", async () => {
    const c = await startMcp({ TV_APP_ALLOW_EVAL: "" });
    const { tools } = await c.listTools();
    assert.ok(!tools.some((t) => t.name === "app_evaluate"));
    const res = await c.callTool({ name: "app_evaluate", arguments: { code: "return 1" } });
    assert.ok(res.isError);
    await c.close();
  });

  await step("clear error when the app is not running", async () => {
    const c = await startMcp({ TV_CDP_URL: "http://127.0.0.1:9" });
    const res = await c.callTool({ name: "app_status", arguments: {} });
    assert.ok(res.isError);
    assert.match(text(res), /remote-debugging-port=9222/);
    await c.close();
  });

  await step("clear error when no chart tab is open", async () => {
    const c = await startMcp({ TV_APP_URL_MATCH: "tradingview\\.com/chart" });
    const res = await c.callTool({ name: "app_status", arguments: {} });
    assert.ok(res.isError);
    assert.match(text(res), /no open chart matches/);
    await c.close();
  });

  console.log(`\n${passed} passed. Screenshot: ${SCREENSHOT_OUT}`);
} catch {
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  browserProc.kill();
  http.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
