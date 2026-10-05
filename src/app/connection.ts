import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { SessionData } from "../types.js";

/**
 * Connection to a running TradingView app.
 *
 * Two modes (TV_APP_MODE):
 *  - "cdp" (default): attach to an already running TradingView Desktop app
 *    (or any Chromium) started with --remote-debugging-port. Nothing is
 *    launched; the user's own app window is controlled.
 *  - "launch": start our own Chromium window on tradingview.com/chart,
 *    re-using the cookies from .tv_session.json when present.
 */

const MODE = (process.env.TV_APP_MODE ?? "cdp").toLowerCase();
const CDP_URL = process.env.TV_CDP_URL ?? "http://127.0.0.1:9222";
const CHART_URL = process.env.TV_CHART_URL ?? "https://www.tradingview.com/chart/";
const URL_MATCH = new RegExp(process.env.TV_APP_URL_MATCH ?? "tradingview\\.com/chart", "i");
const HEADLESS = process.env.TV_APP_HEADLESS === "1";
const SESSION_FILE = process.env.TV_SESSION_FILE ?? ".tv_session.json";
const READY_TIMEOUT_MS = Number(process.env.TV_APP_READY_TIMEOUT_MS ?? 30_000);

let browser: Browser | null = null;
let launchedContext: BrowserContext | null = null;
let currentPage: Page | null = null;

export function connectionInfo() {
  return { mode: MODE, cdpUrl: MODE === "cdp" ? CDP_URL : undefined, urlMatch: URL_MATCH.source };
}

/** Returns the TradingView chart page, (re)connecting when needed. */
export async function getChartPage(): Promise<Page> {
  if (currentPage && !currentPage.isClosed() && browser?.isConnected()) {
    return currentPage;
  }
  currentPage = MODE === "launch" ? await launchPage() : await attachPage();
  await waitForChartApi(currentPage);
  return currentPage;
}

export async function disconnect(): Promise<void> {
  // In CDP mode close() only drops our connection; the user's app stays open.
  await browser?.close().catch(() => {});
  browser = null;
  launchedContext = null;
  currentPage = null;
}

async function attachPage(): Promise<Page> {
  if (!browser?.isConnected()) {
    try {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new Error(
        `Cannot reach the TradingView app at ${CDP_URL} (${msg}).\n` +
        `Start TradingView Desktop with remote debugging enabled, e.g.:\n` +
        `  Windows: "%LOCALAPPDATA%\\TradingView\\TradingView.exe" --remote-debugging-port=9222\n` +
        `  macOS:   open -a TradingView --args --remote-debugging-port=9222\n` +
        `  Linux:   tradingview --remote-debugging-port=9222\n` +
        `Or set TV_APP_MODE=launch to open a browser window instead.`
      );
    }
  }

  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => URL_MATCH.test(p.url()));
  if (!page) {
    const urls = pages.map((p) => p.url()).join(", ") || "(none)";
    throw new Error(
      `Connected to ${CDP_URL}, but no open chart matches /${URL_MATCH.source}/. ` +
      `Open a chart tab in the app. Open pages: ${urls}`
    );
  }
  return page;
}

async function launchPage(): Promise<Page> {
  if (!browser?.isConnected() || !launchedContext) {
    browser = await chromium.launch({
      headless: HEADLESS,
      executablePath: process.env.TV_BROWSER_PATH || undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    launchedContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const cookies = await loadSessionCookies();
    if (cookies.length) await launchedContext.addCookies(cookies);
  }
  const existing = launchedContext.pages().find((p) => URL_MATCH.test(p.url()));
  if (existing) return existing;
  const page = await launchedContext.newPage();
  await page.goto(CHART_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

async function loadSessionCookies() {
  if (!existsSync(SESSION_FILE)) return [];
  try {
    const data: SessionData = JSON.parse(await readFile(SESSION_FILE, "utf-8"));
    return data.cookies.map((c) => ({
      name: c.key,
      value: c.value,
      domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
      path: c.path || "/",
      expires: c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    }));
  } catch {
    return [];
  }
}

async function waitForChartApi(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const api = (window as any).TradingViewApi;
        if (!api || typeof api.activeChart !== "function") return false;
        try {
          return !!api.activeChart().symbol();
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: READY_TIMEOUT_MS }
    );
  } catch {
    throw new Error(
      `The page ${page.url()} is open, but the TradingView chart API did not become ready ` +
      `within ${READY_TIMEOUT_MS / 1000}s. Make sure a chart (not the home page) is shown.`
    );
  }
}
