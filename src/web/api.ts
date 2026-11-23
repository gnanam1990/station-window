/**
 * API client for the workbench. Browser path: session cookie is set by the
 * server and flows automatically; we only carry the CSRF header. Tests may
 * inject a transport (e.g. a real listening server through undici fetch).
 */
export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  /** set-cookie value, visible to non-browser transports only (HttpOnly in real browsers) */
  setCookie?: string;
}

export type Transport = (req: {
  method: string; path: string; body?: unknown; headers: Record<string, string>;
}) => Promise<ApiResponse>;

export class ApiError2 extends Error {
  constructor(readonly status: number, readonly code: string,
    message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

export class ApiClient {
  csrf: string | null = null;
  role: string | null = null;
  deskSlug: string | null = null;
  sessionToken: string | null = null;

  constructor(readonly transport?: Transport) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.csrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    if (this.sessionToken) headers.cookie = `sw_session=${this.sessionToken}`;
    const t = this.transport ?? defaultTransport;
    const res = await t({ method, path, body, headers });
    if (res.status >= 400) {
      const e = (res.body as { error?: { code?: string; message?: string; detail?: Record<string, unknown> } }).error;
      throw new ApiError2(res.status, e?.code ?? "error", e?.message ?? `HTTP ${res.status}`, e?.detail);
    }
    return res.body as T;
  }

  get<T = unknown>(path: string) { return this.request<T>("GET", path); }
  post<T = unknown>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }

  async login(apiKey: string) {
    const res = await (this.transport ?? defaultTransport)({
      method: "POST", path: "/api/session", body: { apiKey },
      headers: { "content-type": "application/json" },
    });
    if (res.status >= 400) throw new ApiError2(res.status, "unauthorized", "login failed");
    if (res.setCookie) {
      const m = res.setCookie.match(/sw_session=([^;]+)/);
      if (m?.[1]) this.sessionToken = m[1];
    }
    const b = res.body as { csrf: string; desk: string; role: string };
    this.csrf = b.csrf; this.deskSlug = b.desk; this.role = b.role;
    return b;
  }
}

const defaultTransport: Transport = async ({ method, path, body, headers }) => {
  const res = await fetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
