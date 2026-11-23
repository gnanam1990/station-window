export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** Listen host; loopback by default for local services. */
  host: string;
  /** Deployment mode: dev | replay | competition. Competition mode is required for live Delphi transport. */
  mode: "dev" | "replay" | "competition";
  /** Base URL of the Delphi evidence API including /v1. Empty disables live transport. */
  delphiBaseUrl: string;
  /** Bearer credential for the Delphi evidence API. Never exposed via API or web. */
  delphiApiKey: string;
  /** Provider account label used for idempotency scoping. */
  delphiAccount: string;
  delphiAgentId: string;
  /** Explicit operator opt-in required before any real submission is sent. */
  liveSubmissionsEnabled: boolean;
  /** Max bytes a source fetcher will download. */
  fetchMaxBytes: number;
  fetchTimeoutMs: number;
}

export function loadConfig(env = process.env): AppConfig {
  return {
    databaseUrl:
      env.SW_DATABASE_URL ?? "postgres://station:station_local_dev@127.0.0.1:55432/station_window",
    port: Number(env.SW_PORT ?? 8787),
    host: env.SW_HOST ?? "127.0.0.1",
    mode: (env.SW_MODE as AppConfig["mode"]) ?? "dev",
    delphiBaseUrl: env.DELPHI_BASE_URL ?? "",
    delphiApiKey: env.DELPHI_API_KEY ?? "",
    delphiAccount: env.DELPHI_ACCOUNT ?? "default",
    delphiAgentId: env.DELPHI_AGENT_ID ?? "station-window",
    liveSubmissionsEnabled: env.SW_LIVE_SUBMISSIONS === "yes",
    fetchMaxBytes: Number(env.SW_FETCH_MAX_BYTES ?? 2_000_000),
    fetchTimeoutMs: Number(env.SW_FETCH_TIMEOUT_MS ?? 15_000),
  };
}
