import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { FrozenClock, SystemClock, type Clock } from "../src/core/clock.ts";
import { seedFreshDesk, type SeededKeys } from "../src/seed.ts";
import type { FastifyInstance } from "fastify";

const ADMIN_URL =
  process.env.SW_DATABASE_URL ?? "postgres://station:station_local_dev@127.0.0.1:55432/postgres";

export interface TestEnv {
  pool: pg.Pool;
  dbName: string;
  app: FastifyInstance;
  config: AppConfig;
  clock: FrozenClock;
  close: () => Promise<void>;
}

/** Fresh migrated database per test file; the API app shares the same pool. */
export async function makeTestEnv(opts: {
  clock?: Clock;
  config?: Partial<AppConfig>;
} = {}): Promise<TestEnv> {
  const admin = createPool(ADMIN_URL);
  const dbName = `sw_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  const clock = (opts.clock ?? new FrozenClock(new Date("2026-11-30T12:00:00Z"))) as FrozenClock;
  const config = { ...loadConfig(), databaseUrl: url.toString(), ...opts.config };
  const app = await buildApp({ config, pool, clock });
  return {
    pool,
    dbName,
    app,
    config,
    clock,
    close: async () => {
      await app.close();
      await pool.end();
      const admin2 = createPool(ADMIN_URL);
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin2.end();
    },
  };
}

export async function seed(env: TestEnv, slug = "desk-a"): Promise<SeededKeys> {
  return seedFreshDesk(env.pool, slug);
}

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** Browser-style login via /api/session; returns cookie + csrf headers. */
export async function login(env: TestEnv, apiKey: string) {
  const res = await env.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { apiKey },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const setCookie = res.headers["set-cookie"] as string;
  const cookie = setCookie.split(";")[0]!;
  const body = res.json() as { csrf: string; role: string; desk: string };
  return {
    cookie,
    csrf: body.csrf,
    role: body.role,
    headers: (extra: Record<string, string> = {}) => ({
      cookie,
      "x-csrf-token": body.csrf,
      ...extra,
    }),
    getHeaders: (extra: Record<string, string> = {}) => ({ cookie, ...extra }),
  };
}

export async function api(
  env: TestEnv,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  opts: { key?: string; headers?: Record<string, string>; payload?: unknown } = {},
) {
  const res = await env.app.inject({
    method,
    url,
    headers: {
      ...(opts.key ? auth(opts.key) : {}),
      ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    payload: opts.payload as never,
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}
