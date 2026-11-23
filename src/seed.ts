import { randomBytes } from "node:crypto";
import { sha256, uuid } from "./core/ids.js";
import type pg from "pg";
import { withTx, type Db } from "./db/pool.ts";
import type { Role } from "./auth.ts";

export interface SeededKeys {
  deskId: string;
  keys: Record<Role, string>;
}

/** Return newly issued bootstrap keys only once per desk and role. */
export async function seedDesk(pool: pg.Pool, slug = "demo", mode = "dev"): Promise<SeededKeys> {
  return withTx(pool, async (db) => {
    const { rows: [desk] } = await db.query(
      `INSERT INTO desks(id, slug, display_name, deployment_mode) VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`,
      [uuid(), slug, `Desk ${slug}`, mode],
    );
    const { rows: existing } = await db.query("SELECT DISTINCT role FROM memberships WHERE desk_id=$1", [desk.id]);
    const roles = new Set(existing.map((row) => row.role as Role));
    const keys = {} as Record<Role, string>;
    for (const role of ["analyst", "editor", "worker", "auditor"] as const) {
      if (roles.has(role)) {
        keys[role] = "(existing — key not recoverable)";
        continue;
      }
      const key = `swk_${slug}_${role}_${randomBytes(16).toString("hex")}`;
      const principal = uuid();
      await db.query(
        "INSERT INTO principals(id, desk_id, kind, display_name, api_key_hash) VALUES ($1,$2,$3,$4,$5)",
        [principal, desk.id, role === "worker" ? "worker" : "user", `${slug}-${role}`, sha256(key)],
      );
      await db.query("INSERT INTO memberships(desk_id, principal_id, role) VALUES ($1,$2,$3)",
        [desk.id, principal, role]);
      keys[role] = key;
    }
    return { deskId: desk.id as string, keys };
  });
}

/** Test helper: always creates a fresh desk with fresh printable keys. */
export async function seedFreshDesk(db: Db, slug: string): Promise<SeededKeys> {
  const deskId = uuid();
  await db.query("INSERT INTO desks(id, slug, display_name) VALUES ($1,$2,$3)", [
    deskId,
    slug,
    `Desk ${slug}`,
  ]);
  const keys = {} as Record<Role, string>;
  for (const role of ["analyst", "editor", "worker", "auditor"] as Role[]) {
    const key = `swk_${slug}_${role}_${randomBytes(16).toString("hex")}`;
    const pid = uuid();
    await db.query(
      "INSERT INTO principals(id, desk_id, kind, display_name, api_key_hash) VALUES ($1,$2,$3,$4,$5)",
      [pid, deskId, role === "worker" ? "worker" : "user", `${slug}-${role}`, sha256(key)],
    );
    await db.query("INSERT INTO memberships(desk_id, principal_id, role) VALUES ($1,$2,$3)", [
      deskId,
      pid,
      role,
    ]);
    keys[role] = key;
  }
  return { deskId, keys };
}
