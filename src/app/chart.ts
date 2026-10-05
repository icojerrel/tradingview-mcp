import type { Page } from "playwright";
import { getChartPage } from "./connection.js";

/**
 * Chart control through the chart API that the TradingView app exposes on
 * `window.TradingViewApi` (the same widget API as TradingView's Charting
 * Library: activeChart().setSymbol(), createStudy(), createShape(), ...).
 *
 * Every function body passed to page.evaluate() runs inside the app, so it
 * must be self-contained (no references to anything in this module).
 */

const RESOLUTIONS: Record<string, string> = {
  "1m": "1", "2m": "2", "3m": "3", "5m": "5", "10m": "10", "15m": "15", "30m": "30", "45m": "45",
  "1h": "60", "2h": "120", "3h": "180", "4h": "240",
  "1d": "1D", "d": "1D", "1w": "1W", "w": "1W", "1mo": "1M", "1mn": "1M", "1month": "1M",
};

/** Normalises "5m" / "1h" / "4H" / "1D" / "60" / "1M" to TradingView resolution strings. */
export function normalizeResolution(input: string): string {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return raw; // minutes, already native
  if (/^\d+[SDWM]$/.test(raw)) return raw; // native: 30S, 1D, 1W, 1M (M = month)
  const mapped = RESOLUTIONS[raw.toLowerCase()];
  if (mapped) return mapped;
  const m = raw.match(/^(\d+)\s*([a-z]+)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "s") return `${n}S`;
    if (unit === "m" || unit === "min") return String(n);
    if (unit === "h") return String(n * 60);
    if (unit === "d") return `${n}D`;
    if (unit === "w") return `${n}W`;
    if (unit === "mo" || unit === "mn") return `${n}M`;
  }
  throw new Error(`Unknown timeframe "${input}". Use e.g. 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M.`);
}

export const CHART_TYPES: Record<string, number> = {
  bars: 0, candles: 1, line: 2, area: 3, renko: 4, kagi: 5, point_and_figure: 6, line_break: 7,
  heikin_ashi: 8, hollow_candles: 9, baseline: 10, high_low: 12, columns: 13,
  line_with_markers: 14, step_line: 15, hlc_area: 16,
};

// ─── State ────────────────────────────────────────────────────────────────────

export interface ChartState {
  symbol: string;
  resolution: string;
  chartType: string | number;
  visibleRange: { from: number; to: number } | null;
  indicators: { id: string; name: string }[];
  drawings: { id: string; name: string }[];
  chartsInLayout: number | null;
  url: string;
  title: string;
}

export async function getState(): Promise<ChartState> {
  const page = await getChartPage();
  const state = await page.evaluate((types: Record<string, number>) => {
    const api = (window as any).TradingViewApi;
    const chart = api.activeChart();
    const safe = <T>(fn: () => T, fallback: T): T => {
      try { return fn() ?? fallback; } catch { return fallback; }
    };
    const typeNum = safe(() => chart.chartType(), -1);
    const typeName = Object.keys(types).find((k) => types[k] === typeNum) ?? typeNum;
    return {
      symbol: chart.symbol(),
      resolution: chart.resolution(),
      chartType: typeName,
      visibleRange: safe(() => chart.getVisibleRange(), null),
      indicators: safe(() => chart.getAllStudies(), []).map((s: any) => ({ id: String(s.id), name: s.name })),
      drawings: safe(() => chart.getAllShapes(), []).map((s: any) => ({ id: String(s.id), name: s.name })),
      chartsInLayout: safe(() => api.chartsCount(), null),
    };
  }, CHART_TYPES);
  return { ...state, url: page.url(), title: await page.title() };
}

// ─── Symbol / timeframe / type ────────────────────────────────────────────────

export async function setSymbol(symbol: string): Promise<ChartState> {
  const page = await getChartPage();
  await page.evaluate(async (sym: string) => {
    const chart = (window as any).TradingViewApi.activeChart();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out loading symbol ${sym}`)), 20_000);
      const done = () => { clearTimeout(timer); resolve(); };
      const ret = chart.setSymbol(sym, done);
      if (ret && typeof ret.then === "function") ret.then(done, reject);
    });
  }, symbol);
  await waitForData(page);
  return getState();
}

export async function setResolution(timeframe: string): Promise<ChartState> {
  const resolution = normalizeResolution(timeframe);
  const page = await getChartPage();
  await page.evaluate(async (res: string) => {
    const chart = (window as any).TradingViewApi.activeChart();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out switching to ${res}`)), 20_000);
      const done = () => { clearTimeout(timer); resolve(); };
      const ret = chart.setResolution(res, done);
      if (ret && typeof ret.then === "function") ret.then(done, reject);
    });
  }, resolution);
  await waitForData(page);
  return getState();
}

export async function setChartType(type: string): Promise<ChartState> {
  const value = CHART_TYPES[type];
  if (value === undefined) {
    throw new Error(`Unknown chart type "${type}". Options: ${Object.keys(CHART_TYPES).join(", ")}`);
  }
  const page = await getChartPage();
  await page.evaluate((v: number) => {
    (window as any).TradingViewApi.activeChart().setChartType(v);
  }, value);
  return getState();
}

async function waitForData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const chart = (window as any).TradingViewApi.activeChart();
    if (typeof chart.dataReady !== "function") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      const ready = chart.dataReady(() => { clearTimeout(timer); resolve(); });
      if (ready === true) { clearTimeout(timer); resolve(); }
    });
  });
}

// ─── Indicators ───────────────────────────────────────────────────────────────

export async function addIndicator(opts: {
  name: string;
  inputs?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  forceOverlay?: boolean;
}): Promise<{ id: string; name: string; indicators: { id: string; name: string }[] }> {
  const page = await getChartPage();
  return page.evaluate(async (o) => {
    const chart = (window as any).TradingViewApi.activeChart();
    const before = new Set(chart.getAllStudies().map((s: any) => String(s.id)));
    let id = await chart.createStudy(o.name, o.forceOverlay ?? false, false, o.inputs, o.overrides);
    const all = chart.getAllStudies().map((s: any) => ({ id: String(s.id), name: s.name }));
    if (id == null) id = all.find((s: any) => !before.has(s.id))?.id ?? null;
    if (id == null) {
      throw new Error(`TradingView did not add "${o.name}". Use the exact indicator name as shown in the Indicators dialog, e.g. "Relative Strength Index".`);
    }
    const added = all.find((s: any) => s.id === String(id));
    return { id: String(id), name: added?.name ?? o.name, indicators: all };
  }, opts);
}

export async function getIndicator(id: string) {
  const page = await getChartPage();
  return page.evaluate((studyId: string) => {
    const chart = (window as any).TradingViewApi.activeChart();
    const study = chart.getStudyById(studyId);
    if (!study) throw new Error(`No indicator with id ${studyId}`);
    const meta = chart.getAllStudies().find((s: any) => String(s.id) === studyId);
    let inputs: unknown = null;
    try { inputs = study.getInputValues(); } catch { /* not supported */ }
    let visible: unknown = null;
    try { visible = study.isVisible(); } catch { /* not supported */ }
    return { id: studyId, name: meta?.name ?? null, visible, inputs };
  }, id);
}

export async function updateIndicator(opts: {
  id: string;
  inputs?: Record<string, unknown>;
  visible?: boolean;
}) {
  const page = await getChartPage();
  await page.evaluate((o) => {
    const chart = (window as any).TradingViewApi.activeChart();
    const study = chart.getStudyById(o.id);
    if (!study) throw new Error(`No indicator with id ${o.id}`);
    if (o.inputs) {
      study.setInputValues(Object.entries(o.inputs).map(([id, value]) => ({ id, value })));
    }
    if (o.visible !== undefined) study.setVisible(o.visible);
  }, opts);
  return getIndicator(opts.id);
}

export async function removeIndicator(id: string) {
  const page = await getChartPage();
  return page.evaluate((studyId: string) => {
    const chart = (window as any).TradingViewApi.activeChart();
    const exists = chart.getAllStudies().some((s: any) => String(s.id) === studyId);
    if (!exists) throw new Error(`No indicator with id ${studyId}`);
    chart.removeEntity(studyId);
    return chart.getAllStudies().map((s: any) => ({ id: String(s.id), name: s.name }));
  }, id);
}

// ─── Drawings ─────────────────────────────────────────────────────────────────

export interface ShapePoint { time?: number; price: number }

export async function drawShape(opts: {
  shape: string;
  points: ShapePoint[];
  text?: string;
  overrides?: Record<string, unknown>;
  lock?: boolean;
}): Promise<{ id: string; drawings: { id: string; name: string }[] }> {
  const page = await getChartPage();
  return page.evaluate(async (o) => {
    const chart = (window as any).TradingViewApi.activeChart();
    // Points without a time are anchored to the right edge of the visible range.
    let fallbackTime = Math.floor(Date.now() / 1000);
    try { fallbackTime = chart.getVisibleRange().to; } catch { /* keep now */ }
    const points = o.points.map((p) => ({ time: p.time ?? fallbackTime, price: p.price }));
    const options: Record<string, unknown> = { shape: o.shape, lock: o.lock ?? false };
    if (o.text !== undefined) options.text = o.text;
    if (o.overrides) options.overrides = o.overrides;
    const id = points.length === 1
      ? await chart.createShape(points[0], options)
      : await chart.createMultipointShape(points, options);
    if (id == null) {
      throw new Error(`TradingView did not create a "${o.shape}" with ${points.length} point(s). Check the shape name and number of points.`);
    }
    const drawings = chart.getAllShapes().map((s: any) => ({ id: String(s.id), name: s.name }));
    return { id: String(id), drawings };
  }, opts);
}

export async function removeDrawings(ids?: string[]) {
  const page = await getChartPage();
  return page.evaluate((list: string[] | null) => {
    const chart = (window as any).TradingViewApi.activeChart();
    if (!list) {
      chart.removeAllShapes();
    } else {
      const existing = new Set(chart.getAllShapes().map((s: any) => String(s.id)));
      const missing = list.filter((id) => !existing.has(id));
      if (missing.length) throw new Error(`Unknown drawing id(s): ${missing.join(", ")}`);
      for (const id of list) chart.removeEntity(id);
    }
    return chart.getAllShapes().map((s: any) => ({ id: String(s.id), name: s.name }));
  }, ids ?? null);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export async function setVisibleRange(from: number, to: number) {
  if (!(to > from)) throw new Error("'to' must be later than 'from'");
  const page = await getChartPage();
  await page.evaluate(async (r) => {
    await (window as any).TradingViewApi.activeChart().setVisibleRange(r);
  }, { from, to });
  return getState();
}

export async function executeAction(actionId: string) {
  const page = await getChartPage();
  await page.evaluate((id: string) => {
    (window as any).TradingViewApi.activeChart().executeActionById(id);
  }, actionId);
  return getState();
}

// ─── Data ─────────────────────────────────────────────────────────────────────

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }

/** Returns the most recent `count` bars that are loaded in the chart. */
export async function getVisibleBars(count: number): Promise<{ symbol: string; resolution: string; bars: Bar[] }> {
  const page = await getChartPage();
  return page.evaluate(async (n: number) => {
    const api = (window as any).TradingViewApi;
    const chart = api.activeChart();
    let bars: any[] = [];
    if (typeof chart.exportData === "function") {
      const exp = await chart.exportData({ includeTime: true, includeSeries: true, includedStudies: [] });
      const cols: string[] = exp.schema.map((f: any) =>
        f.type === "time" ? "time" : String(f.plotTitle ?? "").toLowerCase());
      const idx = (name: string) => cols.findIndex((c) => c === name || c.endsWith(name));
      const [t, o, h, l, c, v] = ["time", "open", "high", "low", "close", "volume"].map(idx);
      bars = exp.data.map((row: number[]) => ({
        time: row[t], open: row[o], high: row[h], low: row[l], close: row[c],
        ...(v >= 0 ? { volume: row[v] } : {}),
      }));
    } else {
      // Fallback for app builds without exportData: read the main series directly.
      const series = api._activeChartWidgetWV?.value?.()?._chartWidget?.model?.()?.mainSeries?.()?.bars?.();
      if (!series || typeof series.valueAt !== "function") {
        throw new Error("This TradingView build exposes no way to read chart bars. Use get_ohlcv from the data MCP instead.");
      }
      for (let i = series.firstIndex(); i <= series.lastIndex(); i++) {
        const b = series.valueAt(i);
        if (b) bars.push({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] });
      }
    }
    return { symbol: chart.symbol(), resolution: chart.resolution(), bars: bars.slice(-n) };
  }, count);
}

// ─── Screenshot / input / eval ────────────────────────────────────────────────

const CHART_SELECTORS = [".chart-container.active", ".layout__area--center", ".chart-container"];

export async function screenshot(fullWindow: boolean): Promise<Buffer> {
  const page = await getChartPage();
  if (!fullWindow) {
    for (const sel of CHART_SELECTORS) {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible()) {
        return el.screenshot({ type: "png" });
      }
    }
  }
  return page.screenshot({ type: "png" });
}

export async function pressKeys(keys: string[]): Promise<void> {
  const page = await getChartPage();
  await page.bringToFront().catch(() => {});
  for (const key of keys) await page.keyboard.press(key);
}

export async function evaluate(expression: string): Promise<unknown> {
  const page = await getChartPage();
  return page.evaluate(async (src: string) => {
    // eslint-disable-next-line no-new-func
    const result = await new Function(`return (async () => { ${src} })()`)();
    try { return JSON.parse(JSON.stringify(result ?? null)); } catch { return String(result); }
  }, expression);
}
