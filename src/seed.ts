import { randomBytes } from "node:crypto";
import { sha256, uuid } from "./core/ids.js";
import type { Db } from "./db/pool.ts";
import type { Role } from "./auth.ts";

export interface SeededKeys {
  deskId: string;
  keys: Record<Role, string>;
}

/** Create (or return) a desk with one principal per scope. Prints nothing; keys returned to caller. */
export async function seedDesk(db: Db, slug = "demo", mode = "dev"): Promise<SeededKeys> {
  let deskId: string;
  const existing = await db.query("SELECT id FROM desks WHERE slug=$1", [slug]);
  if (existing.rows.length > 0) {
    deskId = existing.rows[0].id as string;
  } else {
    deskId = uuid();
    await db.query("INSERT INTO desks(id, slug, display_name, deployment_mode) VALUES ($1,$2,$3,$4)", [
      deskId,
      slug,
      `Desk ${slug}`,
      mode,
    ]);
  }
  const keys = {} as Record<Role, string>;
  for (const role of ["analyst", "editor", "worker", "auditor"] as Role[]) {
    const key = `swk_${slug}_${role}_${randomBytes(16).toString("hex")}`;
    const pid = uuid();
    await db.query(
      `INSERT INTO principals(id, desk_id, kind, display_name, api_key_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (api_key_hash) DO NOTHING`,
      [pid, deskId, role === "worker" ? "worker" : "user", `${slug}-${role}`, sha256(key)],
    );
    const inserted = await db.query(
      `INSERT INTO memberships(desk_id, principal_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (desk_id, principal_id) DO NOTHING RETURNING principal_id`,
      [deskId, pid, role],
    );
    if (inserted.rows.length > 0) keys[role] = key;
    else {
      // desk already had principals; regenerate is not possible without the old key — report
      const { rows } = await db.query(
        `SELECT p.id FROM principals p JOIN memberships m ON m.principal_id=p.id
         WHERE p.desk_id=$1 AND m.role=$2 LIMIT 1`,
        [deskId, role],
      );
      keys[role] = rows.length ? "(existing — key not recoverable)" : key;
    }
  }
  return { deskId, keys };
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
