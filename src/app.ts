import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import pg from "pg";
import { loadConfig, type AppConfig } from "./config.ts";
import { clockFromEnv, type Clock } from "./core/clock.ts";
import { ApiError } from "./core/errors.ts";
import {
  authenticateApiKey,
  authenticateSession,
  createSession,
  parseCookies,
  type RequestContext,
} from "./auth.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { unauthorized } from "./core/errors.ts";
import { sha256 } from "./core/ids.ts";

export interface AppDeps {
  config: AppConfig;
  pool: pg.Pool;
  clock: Clock;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(deps?: Partial<AppDeps>): Promise<FastifyInstance> {
  const config = deps?.config ?? loadConfig();
  const pool = deps?.pool ?? createPool(config.databaseUrl);
  const clock = deps?.clock ?? clockFromEnv();

  const app = Fastify({ logger: false, disableRequestLogging: true });
  app.decorateRequest("ctx");

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, detail: err.detail ?? {} } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "internal error" } });
  });

  // -- auth hook: resolves the desk strictly from the credential, never from posted ids --
  app.addHook("preHandler", async (req) => {
    const publicPaths = ["/api/health", "/api/session"];
    if (req.method === "GET" && publicPaths.includes(req.routeOptions.url ?? "")) return;
    if ((req.routeOptions.url ?? "").startsWith("/api/health")) return;
    if (req.routeOptions.url === "/api/session" && req.method === "POST") return;

    let principal: Awaited<ReturnType<typeof authenticateApiKey>> = null;
    let authKind: RequestContext["authKind"] = "api_key";
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : (req.headers["x-api-key"] as string | undefined);
    if (bearer) {
      principal = await authenticateApiKey(pool, bearer);
    } else {
      const cookies = parseCookies(req.headers.cookie);
      const tok = cookies["sw_session"];
      if (tok) {
        const sess = await authenticateSession(pool, tok, clock);
        if (sess) {
          principal = sess.principal;
          authKind = "session";
          if (MUTATING.has(req.method)) {
            const csrf = req.headers["x-csrf-token"] as string | undefined;
            if (!csrf || sha256(csrf) !== sess.csrfHash)
              throw unauthorized("csrf token missing or invalid");
          }
        }
      }
    }
    if (!principal) throw unauthorized();
    req.ctx = {
      deskId: principal.desk_id,
      deskSlug: principal.desk_slug,
      principalId: principal.id,
      role: principal.role,
      authKind,
      clock,
    };
  });

  app.get("/api/health", async () => {
    const serverTime = clock.now();
    const { rows } = await pool.query("SELECT now() AS db_now");
    const dbNow = new Date(rows[0].db_now as string);
    return {
      ok: true,
      mode: config.mode,
      clockSource: clock.source(),
      serverTime: serverTime.toISOString(),
      dbTime: dbNow.toISOString(),
      clockDriftMs: Math.abs(dbNow.getTime() - serverTime.getTime()),
      delphi: { configured: Boolean(config.delphiBaseUrl), liveSubmissions: config.liveSubmissionsEnabled },
    };
  });

  app.get("/api/ready", async () => {
    await pool.query("SELECT 1");
    return { ready: true };
  });

  // -- session (browser) auth --
  app.post("/api/session", async (req, reply) => {
    const body = (req.body ?? {}) as { apiKey?: string };
    if (!body.apiKey) throw unauthorized();
    const principal = await authenticateApiKey(pool, body.apiKey);
    if (!principal) throw unauthorized("invalid api key");
    const sess = await createSession(pool, principal.id, clock);
    reply.header(
      "set-cookie",
      `sw_session=${sess.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`,
    );
    return { csrf: sess.csrf, desk: principal.desk_slug, role: principal.role, expiresAt: sess.expiresAt };
  });

  app.delete("/api/session", async (req, reply) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies["sw_session"]) {
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash=$1", [
        sha256(cookies["sw_session"]),
      ]);
    }
    reply.header("set-cookie", "sw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return { ok: true };
  });

  app.get("/api/me", async (req) => ({
    deskId: req.ctx.deskId,
    deskSlug: req.ctx.deskSlug,
    role: req.ctx.role,
    clockSource: req.ctx.clock.source(),
    serverTime: req.ctx.clock.now().toISOString(),
  }));

  const { registerMarketRoutes } = await import("./routes/markets.ts");
  registerMarketRoutes(app, pool);
  const { registerSourceRoutes } = await import("./routes/sources.ts");
  registerSourceRoutes(app, pool, config, clock);

  return app;
}

export interface StartedApp {
  app: FastifyInstance;
  pool: pg.Pool;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(deps?: Partial<AppDeps>): Promise<StartedApp> {
  const config = deps?.config ?? loadConfig();
  const pool = deps?.pool ?? createPool(config.databaseUrl);
  await migrate(pool);
  const app = await buildApp({ config, pool, clock: deps?.clock });
  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host}:${config.port}`;
  return {
    app,
    pool,
    url,
    close: async () => {
      await app.close();
      if (!deps?.pool) await pool.end();
    },
  };
}
