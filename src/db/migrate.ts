import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sha256 } from "../core/ids.ts";
import type { Db } from "./pool.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Migration files that shipped in an earlier commit and were later replaced.
 * A recorded checksum is accepted only when it is listed here AND the schema
 * check proves the database actually matches what that file produced; then the
 * record is migrated forward to the current checksum once. Unknown checksums
 * are never rewritten.
 */
const KNOWN_VARIANTS: Record<
  number,
  { checksum: string; shippedAt: string; verify: (c: pg.PoolClient) => Promise<boolean> }[]
> = {
  3: [
    {
      // fa3bea8 — first shipped 0003: pre-desk-scope unique, no is_official_final.
      checksum: "2832f5358dc7538fe1f8f28902777597d837ee7d70c2f9df1d91510e243b2227",
      shippedAt: "fa3bea8",
      verify: async (c) => {
        const { rows } = await c.query(
          `SELECT 1 FROM pg_constraint
           WHERE conrelid='observations'::regclass
             AND conname='observations_station_id_dataset_variable_observed_at_seq_key'`,
        );
        return rows.length > 0;
      },
    },
    {
      // e4cd5c7 — M05 shipped 0003: is_official_final inline + desk-scoped unique.
      checksum: "ac3a71da824c3acde20506996e0031211f03b6652d350725d71d4c90bc98157d",
      shippedAt: "e4cd5c7",
      verify: async (c) => {
        const { rows } = await c.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name='observations' AND column_name='is_official_final'`,
        );
        return rows.length > 0;
      },
    },
  ],
};

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
      const recorded = rows[0].checksum as string;
      if (recorded === checksum) continue;
      const variant = (KNOWN_VARIANTS[version] ?? []).find((v) => v.checksum === recorded);
      if (!variant)
        throw new Error(
          `migration ${file} unknown applied checksum ${recorded} — refusing to rewrite; current file=${checksum}`,
        );
      if (!(await variant.verify(client)))
        throw new Error(
          `migration ${file} checksum matches shipped variant ${variant.shippedAt} but the schema does not; refusing to migrate forward`,
        );
      // validated known variant → migrate the record forward once; next run is a no-op
      await client.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
        version, checksum,
      ]);
      applied.push(version);
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
  const pool = db instanceof pg.Pool ? db : undefined;
  const client = pool ? await pool.connect() : db as pg.PoolClient;
  try {
    // The API and worker both migrate at startup. Keep the entire discovery
    // and migration sequence on one locked session across per-file commits.
    await client.query("SELECT pg_advisory_lock(hashtext('station-window/migrations'))");
    try {
      return await migrateOnClient(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('station-window/migrations'))");
    }
  } finally {
    if (pool) client.release();
  }
}
