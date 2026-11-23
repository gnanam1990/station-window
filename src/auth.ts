import { randomBytes } from "node:crypto";
import { sha256, uuid } from "./core/ids.js";
import type { Clock } from "./core/clock.ts";
import { forbidden, unauthorized } from "./core/errors.ts";
import type { Db } from "./db/pool.ts";

export type Role = "auditor" | "analyst" | "editor" | "worker";

export interface RequestContext {
  deskId: string;
  deskSlug: string;
  principalId: string;
  role: Role;
  authKind: "api_key" | "session";
  clock: Clock;
}

const ROLE_RANK: Record<Role, number> = { auditor: 0, analyst: 1, editor: 2, worker: 1 };

export function requireRole(ctx: RequestContext, min: Role): void {
  if (ctx.role === "worker") {
    // worker scope is only for worker-tagged routes; see requireWorker
    if (min === "worker") return;
    throw forbidden("forbidden_role", `worker credential cannot perform ${min} operations`);
  }
  if (ROLE_RANK[ctx.role] < ROLE_RANK[min])
    throw forbidden("forbidden_role", `role ${ctx.role} cannot perform this operation`, {
      required: min,
    });
}

export function requireWorker(ctx: RequestContext): void {
  if (ctx.role !== "worker") throw forbidden("forbidden_role", "worker credential required");
}

interface PrincipalRow {
  id: string;
  desk_id: string;
  desk_slug: string;
  role: Role;
}

async function loadPrincipal(db: Db, principalId: string): Promise<PrincipalRow | null> {
  const { rows } = await db.query(
    `SELECT p.id, p.desk_id, d.slug AS desk_slug, m.role
     FROM principals p
     JOIN desks d ON d.id = p.desk_id
     JOIN memberships m ON m.principal_id = p.id AND m.desk_id = p.desk_id
     WHERE p.id = $1 AND p.active AND m.active`,
    [principalId],
  );
  return (rows[0] as PrincipalRow | undefined) ?? null;
}

export async function authenticateApiKey(db: Db, key: string): Promise<PrincipalRow | null> {
  const { rows } = await db.query(
    `SELECT p.id FROM principals p WHERE p.api_key_hash = $1 AND p.active`,
    [sha256(key)],
  );
  if (rows.length === 0) return null;
  return loadPrincipal(db, rows[0].id as string);
}

export async function createSession(
  db: Db,
  principalId: string,
  clock: Clock,
): Promise<{ token: string; csrf: string; expiresAt: Date }> {
  const token = `sws_${randomBytes(24).toString("hex")}`;
  const csrf = `swc_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(clock.now().getTime() + 12 * 3600_000);
  const p = await loadPrincipal(db, principalId);
  if (!p) throw unauthorized();
  await db.query(
    `INSERT INTO sessions(id, principal_id, desk_id, token_hash, csrf_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuid(), principalId, p.desk_id, sha256(token), sha256(csrf), expiresAt],
  );
  return { token, csrf, expiresAt };
}

export async function authenticateSession(
  db: Db,
  token: string,
  clock: Clock,
): Promise<{ principal: PrincipalRow; csrfHash: string } | null> {
  const { rows } = await db.query(
    `SELECT s.principal_id, s.csrf_hash FROM sessions s
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256(token), clock.now()],
  );
  if (rows.length === 0) return null;
  const principal = await loadPrincipal(db, rows[0].principal_id as string);
  if (!principal) return null;
  return { principal, csrfHash: rows[0].csrf_hash as string };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
