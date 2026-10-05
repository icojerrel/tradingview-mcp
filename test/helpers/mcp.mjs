// Shared helpers for the trading e2e tests: start dist/trading/index.js over
// stdio with a given environment, and small assertion helpers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const work = mkdtempSync(join(tmpdir(), "trading-e2e-"));
const clients = [];
let n = 0;

export async function startMcp(env = {}) {
  const journal = join(work, `journal-${n++}.jsonl`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/trading/index.js")],
    env: { PATH: process.env.PATH, TRADING_JOURNAL_FILE: journal, TRADING_PAPER_POLL_SEC: "0", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, call, journal };
}

export const text = (r) => r.content[0].text;
export const data = (r) => { assert.ok(!r.isError, `tool error: ${text(r)}`); return JSON.parse(text(r)); };
export const err = (r, re) => { assert.ok(r.isError, `expected error, got ${text(r)}`); assert.match(text(r), re); };

let passed = 0;
export async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack ?? e}`); throw e; }
}

/** Runs the suite, prints the result and cleans up. */
export async function run(title, suite, cleanup = () => {}) {
  console.log(title);
  try {
    await suite();
    console.log(`\n${passed} passed.`);
  } catch {
    process.exitCode = 1;
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await cleanup();
    rmSync(work, { recursive: true, force: true });
  }
}
