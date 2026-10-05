# tradingview-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants interact with TradingView — real-time quotes, historical OHLCV data, screener, alerts, watchlists, news, chart layouts, Pine scripts, and more. Connect it to Claude Desktop, Cursor, or any MCP-compatible client and interact with TradingView using natural language.

> **Disclaimer:** This project uses TradingView's internal, undocumented web API. It is not affiliated with or endorsed by TradingView. API endpoints may change without notice. Use in accordance with TradingView's Terms of Service.

---

## How It Works

TradingView's web app communicates with its backend over a private REST API and a proprietary WebSocket protocol. This server:

1. **Authenticates** using a headless Chromium browser (via [Playwright](https://playwright.dev)) to replicate the normal login flow and obtain valid session cookies.
2. **Persists** those cookies to disk so re-authentication only happens when the session expires (~25 days).
3. **Exposes MCP tools** that make authenticated HTTP requests to TradingView's internal endpoints, plus a WebSocket connection for historical OHLCV data.

```
MCP Client (Claude, Cursor…)
        │  MCP protocol (stdio)
        ▼
  tradingview-mcp
        │  HTTPS + session cookies        WebSocket (OHLCV)
        ▼                                        ▼
  tradingview.com REST API       prodata.tradingview.com
```

---

## Features

- **Market Data** — real-time quotes and detailed symbol info (P/E, EPS, beta, sector, 52-week range, etc.)
- **Historical Data** — OHLCV candles via TradingView's WebSocket protocol
- **Screener** — filter stocks, crypto, and forex by price, fundamentals, and technicals
- **Alerts** — list and inspect price alerts
- **Watchlists** — list, create, rename, add/remove symbols, and delete watchlists
- **News & Ideas** — latest headlines per symbol, community ideas search, trending ideas
- **Chart Layouts** — list and inspect saved chart layouts
- **Pine Scripts** — list and retrieve source code for saved indicators and strategies
- **Account** — account details
- **App control** — a second server (`tradingview-app-mcp`) drives the TradingView app itself: symbol, timeframe, indicators, drawings, screenshots ([details](#tradingview-app-control-tradingview-app-mcp))
- **Session persistence** — logs in once via headless browser, reuses cookies for subsequent runs

---

## Installation

### Option A — Docker (recommended)

No Node.js required. Uses the published multi-platform image (`linux/amd64` + `linux/arm64`).

**1. Authenticate once**

```bash
docker run --rm \
  -v tradingview-mcp-session:/data \
  -e TV_USERNAME=your@email.com \
  -e TV_PASSWORD=yourpassword \
  -e TV_SESSION_FILE=/data/.tv_session.json \
  mikeh1975/tradingview-mcp:login
```

This runs a headless Chromium browser, logs into TradingView, and saves the session cookies to a named Docker volume. You only need to redo this when the session expires (~25 days).

**2. Configure Claude Desktop**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "tradingview-mcp-session:/data",
        "-e", "TV_SESSION_FILE=/data/.tv_session.json",
        "mikeh1975/tradingview-mcp:latest"
      ]
    }
  }
}
```

Restart Claude Desktop. You should see "tradingview" in the MCP tools list.

---

### Option B — Local (Node.js)

**Requirements:** Node.js 18+, a TradingView account.

```bash
git clone https://github.com/mikeh-22/tradingview-mcp.git
cd tradingview-mcp
npm install
npx playwright install chromium
npm run build
```

**Configure Claude Desktop:**

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/dist/index.js"],
      "env": {
        "TV_USERNAME": "your_username_or_email",
        "TV_PASSWORD": "your_password"
      }
    }
  }
}
```

On the first run, a headless Chromium browser opens and logs in using your credentials. Session cookies are saved to `.tv_session.json`. All subsequent runs skip the browser entirely.

To force a fresh login, delete `.tv_session.json` or call the `reset_session` tool.

---

## Available Tools

### Market Data

#### `get_quote`
Returns real-time price data for one or more symbols.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbols` | string[] | ✓ | Symbols in `EXCHANGE:TICKER` format, e.g. `["NASDAQ:AAPL", "BINANCE:BTCUSDT"]` |

#### `get_symbol_info`
Returns detailed fundamental and technical data for a single symbol (P/E, EPS, 52-week high/low, beta, sector, dividends, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✓ | Symbol in `EXCHANGE:TICKER` format |

#### `get_ohlcv`
Returns historical OHLCV candlestick data via TradingView's WebSocket protocol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✓ | Symbol in `EXCHANGE:TICKER` format |
| `resolution` | string | ✓ | Timeframe: `1m` `3m` `5m` `15m` `30m` `45m` `1h` `2h` `3h` `4h` `1D` `1W` `1M` |
| `countback` | number | | Number of bars to fetch (default 300) |
| `from` | number | | Start time as Unix timestamp (seconds) |
| `to` | number | | End time as Unix timestamp (seconds) |

---

### Screener

#### `screen_stocks`
Screens US equities using price, volume, fundamental, and technical filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filters` | Filter[] | | Array of filter conditions (see below) |
| `columns` | string[] | | Fields to return (uses sensible defaults if omitted) |
| `sort` | object | | `{ sortBy: string, sortOrder: "asc" \| "desc" }` |
| `range` | [number, number] | | Pagination: `[offset, limit]`, e.g. `[0, 25]` |

#### `screen_crypto`
Screens crypto assets. Same parameters as `screen_stocks`.

#### `screen_forex`
Screens forex pairs. Same parameters as `screen_stocks`.

#### `get_screener_fields`
Returns a reference list of all available screener field names, grouped by category (price, volume, fundamentals, technicals, volatility, metadata).

```
(no parameters)
```

**Filter object format:**

```json
{ "left": "market_cap_basic", "operation": "greater", "right": 1000000000 }
```

Supported operations: `greater`, `less`, `greater_or_equal`, `less_or_equal`, `equal`, `not_equal`, `in_range`, `not_in_range`, `in`, `not_in`, `crosses_up`, `crosses_down`

For `in_range`, `right` should be `[min, max]`. Example — RSI between 30 and 50:

```json
{ "left": "RSI", "operation": "in_range", "right": [30, 50] }
```

---

### Alerts

#### `list_alerts`
Returns all alerts on your account.

```
(no parameters)
```

#### `get_alert`
Returns full details for a single alert.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Alert ID |

---

### Watchlists

#### `list_watchlists`
Returns all watchlists with their symbols.

```
(no parameters)
```

#### `get_watchlist`
Returns a single watchlist and its full symbol list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Watchlist ID |

#### `create_watchlist`
Creates a new watchlist, optionally pre-populated with symbols.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✓ | Watchlist name |
| `symbols` | string[] | | Initial symbols, e.g. `["NASDAQ:AAPL", "NYSE:TSLA"]` |

#### `rename_watchlist`
Renames an existing watchlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Watchlist ID |
| `name` | string | ✓ | New name |

#### `add_symbols`
Adds one or more symbols to a watchlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Watchlist ID |
| `symbols` | string[] | ✓ | Symbols to add |

#### `remove_symbols`
Removes one or more symbols from a watchlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Watchlist ID |
| `symbols` | string[] | ✓ | Symbols to remove |

#### `delete_watchlist`
Permanently deletes a watchlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Watchlist ID |

---

### News & Ideas

#### `get_news`
Returns the latest news headlines for a symbol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✓ | Symbol in `EXCHANGE:TICKER` format |
| `count` | number | | Number of headlines to return (default 20) |

#### `search_ideas`
Searches published TradingView chart ideas.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | | Filter ideas by symbol |
| `query` | string | | Keyword filter |
| `sort` | string | | `recent` (default) or `trending` |
| `page` | number | | Page number (default 1) |

#### `get_trending_ideas`
Returns trending TradingView chart ideas.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | | Page number (default 1) |

---

### Chart Layouts

#### `list_layouts`
Returns all saved chart layouts.

```
(no parameters)
```

#### `get_layout`
Returns details of a saved layout including its name, symbol, and resolution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Layout ID |

---

### Pine Scripts

#### `list_scripts`
Returns Pine Script indicators and strategies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | | `saved` (default) — your saved/favorited scripts; `published` — your published scripts; `all` — entire public library |
| `limit` | number | | Max results (default 100) |

#### `get_script`
Returns the Pine Script source code for a script by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Script ID (e.g. `STD;RSI`) |
| `version` | string | | Script version (uses latest if omitted) |

---

### Account

#### `get_account`
Returns your TradingView account details.

```
(no parameters)
```

---

### Session

#### `reset_session`
Clears the saved session. The next tool call will trigger a fresh Playwright login.

```
(no parameters)
```

---

## TradingView App Control (`tradingview-app-mcp`)

A second MCP server in this repo that **operates the TradingView app itself** — the chart you are looking at — instead of calling the data API. Ask Claude to "switch to BTCUSDT on 4h, add an RSI(21) and draw a horizontal line at 60k" and you see it happen in your own TradingView window.

It attaches to the app over the Chrome DevTools Protocol and drives the chart API that TradingView exposes in the page (`window.TradingViewApi`). Both servers can be configured side by side.

```
MCP Client ──stdio──▶ tradingview-app-mcp ──CDP (port 9222)──▶ TradingView Desktop / browser tab
```

### Setup

**1. Start TradingView Desktop with remote debugging enabled** (and open a chart):

| OS | Command |
|----|---------|
| Windows | `"%LOCALAPPDATA%\TradingView\TradingView.exe" --remote-debugging-port=9222` |
| macOS | `open -a TradingView --args --remote-debugging-port=9222` |
| Linux | `tradingview --remote-debugging-port=9222` |

No Desktop app? Set `TV_APP_MODE=launch` and the server opens its own Chromium window on tradingview.com/chart, re-using the cookies in `.tv_session.json` (from `npm run login`) so you are logged in.

**2. Build and register the server:**

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "tradingview-app": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/dist/app/index.js"],
      "env": { "TV_CDP_URL": "http://127.0.0.1:9222" }
    }
  }
}
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TV_APP_MODE` | `cdp` | `cdp` = attach to a running app; `launch` = open own Chromium window |
| `TV_CDP_URL` | `http://127.0.0.1:9222` | Debugging endpoint of the app (cdp mode) |
| `TV_APP_URL_MATCH` | `tradingview\.com/chart` | Regex used to pick the chart tab/window |
| `TV_CHART_URL` | `https://www.tradingview.com/chart/` | Page opened in launch mode (e.g. your own layout URL) |
| `TV_APP_HEADLESS` | — | `1` = launch mode without a visible window |
| `TV_BROWSER_PATH` | Playwright Chromium | Browser binary for launch mode |
| `TV_APP_ALLOW_EVAL` | — | `1` = expose `app_evaluate` (runs arbitrary JavaScript in the app) |

### Tools

| Tool | What it does |
|------|--------------|
| `app_status` | Connect and report symbol, timeframe, chart type, indicators, drawings, visible range |
| `app_reconnect` | Reconnect after restarting the app or switching tabs |
| `chart_set_symbol` | Change symbol (`BINANCE:BTCUSDT`, `NASDAQ:AAPL`, …) |
| `chart_set_timeframe` | Change timeframe (`1m` `5m` `15m` `1h` `4h` `1D` `1W` `1M`, or native `60`, `240`) |
| `chart_set_type` | Candles, bars, line, area, heikin_ashi, hollow_candles, baseline, renko, … |
| `chart_set_visible_range` | Zoom/scroll to a `from`/`to` Unix time range |
| `chart_execute_action` | Run a built-in action id (`chartReset`, `undo`, `redo`, `insertIndicator`, …) |
| `chart_get_bars` | Read the OHLCV bars loaded in the chart |
| `chart_screenshot` | PNG of the chart (or whole window) returned as an image |
| `indicator_add` | Add a built-in indicator by name with optional inputs/style overrides |
| `indicator_get` / `indicator_update` | Read or change inputs and visibility |
| `indicator_remove` | Remove an indicator |
| `drawing_create` | Horizontal/trend lines, rays, rectangles, text, fib retracements, long/short positions, … |
| `drawing_remove` | Remove specific drawings, or all of them |
| `app_press_keys` | Send keyboard shortcuts (`Alt+H`, `Control+S`, `Escape`, …) |
| `app_evaluate` | *(opt-in)* Run JavaScript in the app |

Closing the MCP server only drops the debugging connection; your TradingView app keeps running.

### Testing

```bash
npm run test:app
```

Starts a real Chromium with a debugging port, opens a stand-in chart page (`test/fixtures/mock-chart.html`) that implements the same `TradingViewApi` calls, and drives every tool through the MCP protocol. It does not contact tradingview.com, so it verifies the server and its calling conventions — not TradingView's live app. If TradingView changes its in-page API, a tool returns an error naming the call that failed.

---

## Symbol Format

TradingView uses an `EXCHANGE:TICKER` format for all symbols:

| Asset | Example |
|-------|---------|
| US stocks | `NASDAQ:AAPL`, `NYSE:TSLA` |
| Crypto | `BINANCE:BTCUSDT`, `COINBASE:ETHUSD` |
| Forex | `FX:EURUSD`, `OANDA:GBPUSD` |
| Futures | `CME:ES1!`, `NYMEX:CL1!` |
| Indices | `SP:SPX`, `NASDAQ:NDX` |

---

## Project Structure

```
src/
├── index.ts       # MCP server entrypoint — tool definitions and request handlers
├── auth.ts        # Playwright login flow — opens headless browser, extracts cookies
├── client.ts      # HTTP client — fetch wrapper with cookie jar, CSRF, and subdomain support
├── types.ts       # Shared TypeScript interfaces
├── alerts.ts      # Alert read operations
├── watchlists.ts  # Watchlist CRUD
├── market.ts      # Quotes and symbol info
├── ohlcv.ts       # Historical OHLCV via TradingView WebSocket protocol
├── screener.ts    # Stock/crypto/forex screener
├── news.ts        # News headlines and community ideas
├── layouts.ts     # Chart layout read operations
├── scripts.ts     # Pine Script source retrieval
├── account.ts     # Account info
└── app/           # tradingview-app-mcp — controls the TradingView app over CDP
    ├── index.ts      # MCP entrypoint and tool definitions
    ├── connection.ts # Attach to the app (CDP) or launch a browser window
    └── chart.ts      # Chart operations via window.TradingViewApi
```

---

## Troubleshooting

**Login fails / Playwright times out**

TradingView's login page may show a CAPTCHA or 2FA prompt. Try setting `headless: false` in `src/auth.ts` to watch the browser and identify what's blocking the flow.

**API requests return 403 or 401**

Your session has likely expired. Delete `.tv_session.json` (or call `reset_session`) to trigger a fresh login. With Docker, re-run the login container.

**API requests return 404 or unexpected shapes**

TradingView's internal API is undocumented and may change without notice. Open your browser's DevTools → Network tab, perform the action manually on tradingview.com, and compare the request URL and payload against the relevant file in `src/`.

**`get_ohlcv` times out**

The WebSocket connection to `prodata.tradingview.com` may be blocked by a firewall, or the symbol format may be incorrect. The timeout is 30 seconds.

**`TV_USERNAME` / `TV_PASSWORD` not found**

When running via Claude Desktop, set credentials in the `env` block of your MCP config rather than relying on a `.env` file — the server process won't automatically source it.

---

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| `docker.yml` | Push to `main`, version tags (`v*.*.*`), PRs to `main` | Builds and pushes multi-platform Docker images (`linux/amd64` + `linux/arm64`) to Docker Hub |

Images published to Docker Hub:
- `mikeh1975/tradingview-mcp:latest` — MCP server (runtime image, no browser)
- `mikeh1975/tradingview-mcp:login` — Login helper (includes Playwright + Chromium)

---

## License

MIT
