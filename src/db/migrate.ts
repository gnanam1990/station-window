import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sha256 } from "../core/ids.ts";
import type { Db } from "./pool.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function migrateOnClient(client: pg.PoolClient): Promise<number[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: number[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = sha256(sql);
    const { rows } = await client.query("SELECT checksum FROM schema_migrations WHERE version=$1", [version]);
    if (rows.length > 0) {
      if (rows[0].checksum !== checksum)
        throw new Error(`migration ${file} checksum drift: applied=${rows[0].checksum} file=${checksum}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2)", [version, checksum]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    applied.push(version);
  }
  return applied;
}

/** Migrations always run on one checked-out connection so BEGIN/COMMIT are real. */
export async function migrate(db: Db): Promise<number[]> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      return await migrateOnClient(client);
    } finally {
      client.release();
    }
  }
  return migrateOnClient(db as pg.PoolClient);
}
