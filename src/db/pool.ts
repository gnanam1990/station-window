import pg from "pg";

const { Pool } = pg;

export type DbClient = pg.PoolClient;
export type Db = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTx<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
