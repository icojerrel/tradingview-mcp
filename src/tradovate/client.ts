import type { Config } from "./config.js";

/**
 * Minimal Tradovate REST client: access-token auth with renewal, JSON
 * requests, and handling of Tradovate's "p-ticket" rate-limit penalty.
 */

interface Token { accessToken: string; expiresAt: number }

// Renew when less than this much lifetime is left (tokens live ~90 minutes).
const RENEW_MARGIN_MS = 10 * 60 * 1000;

export class TradovateClient {
  private token: Token | null = null;

  constructor(private readonly config: Config) {}

  async get<T = any>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T = any>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    return this.send<T>(method, path, body, token);
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    accessToken: string | null,
    pTicket?: string
  ): Promise<T> {
    const payload = pTicket ? { ...(body as object), "p-ticket": pTicket } : body;
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (res.status === 401) {
      this.token = null;
      throw new Error(`Tradovate rejected the access token (401) on ${path}`);
    }
    if (!res.ok) {
      const detail = typeof data === "object" && data ? data.errorText ?? JSON.stringify(data) : text;
      throw new Error(`Tradovate ${method} ${path} failed (${res.status}): ${detail}`);
    }

    // Rate-limit penalty: wait p-time seconds, then retry once with the ticket.
    if (data && typeof data === "object" && data["p-ticket"] && !pTicket) {
      const waitSec = Number(data["p-time"] ?? 1);
      if (data["p-captcha"]) {
        throw new Error("Tradovate requires a captcha for this login. Log in once via the Tradovate web app, then retry.");
      }
      await new Promise((r) => setTimeout(r, Math.min(waitSec, 60) * 1000));
      return this.send<T>(method, path, body, accessToken, data["p-ticket"]);
    }
    if (data && typeof data === "object" && typeof data.errorText === "string" && data.errorText) {
      throw new Error(`Tradovate: ${data.errorText}`);
    }
    return data as T;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - now > RENEW_MARGIN_MS) {
      return this.token.accessToken;
    }
    if (this.token && this.token.expiresAt > now) {
      try {
        const renewed = await this.send<any>("GET", "/auth/renewaccesstoken", undefined, this.token.accessToken);
        this.token = toToken(renewed);
        return this.token.accessToken;
      } catch {
        // fall through to a fresh login
      }
    }

    const c = this.config.credentials;
    const missing = (["name", "password", "cid", "sec"] as const).filter((k) => !c[k]);
    if (missing.length) {
      const vars: Record<string, string> = {
        name: "TRADOVATE_USERNAME", password: "TRADOVATE_PASSWORD", cid: "TRADOVATE_CID", sec: "TRADOVATE_SEC",
      };
      throw new Error(`Missing Tradovate credentials: ${missing.map((k) => vars[k]).join(", ")}`);
    }
    const auth = await this.send<any>("POST", "/auth/accesstokenrequest", {
      name: c.name,
      password: c.password,
      appId: c.appId,
      appVersion: c.appVersion,
      cid: c.cid,
      sec: c.sec,
      deviceId: c.deviceId,
    }, null);
    this.token = toToken(auth);
    return this.token.accessToken;
  }
}

function toToken(data: any): Token {
  if (!data?.accessToken) {
    throw new Error(`Tradovate login failed: ${data?.errorText ?? "no access token returned"}`);
  }
  const expiresAt = data.expirationTime ? Date.parse(data.expirationTime) : Date.now() + 60 * 60 * 1000;
  return { accessToken: data.accessToken, expiresAt };
}
