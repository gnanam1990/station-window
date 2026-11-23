/**
 * swctl — Station Window operator CLI.
 * Commands: migrate seed catalog import-card add-source ingest evaluate research
 *           dispatch outbox poll reconcile replay export backup restore doctor report
 * All commands are desk-scoped via SW_DESK_SLUG + the seeded role key files.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { clockFromEnv, FrozenClock } from "./core/clock.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { seedDesk } from "./seed.ts";
import { seedCatalog } from "./modules/catalog.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const clock = clockFromEnv();
const [cmd, ...args] = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function deskCtx(slug: string, role = "editor") {
  const { rows } = await pool.query(
    `SELECT d.id AS desk_id, d.slug, p.id AS principal_id, m.role
     FROM desks d JOIN principals p ON p.desk_id=d.id
     JOIN memberships m ON m.principal_id=p.id AND m.desk_id=d.id
     WHERE d.slug=$1 AND m.role=$2 AND p.active AND m.active LIMIT 1`,
    [slug, role],
  );
  if (rows.length === 0) throw new Error(`desk ${slug} has no active ${role}`);
  return {
    deskId: rows[0].desk_id as string,
    deskSlug: slug,
    principalId: rows[0].principal_id as string,
    role: rows[0].role as never,
    authKind: "api_key" as const,
    clock,
  };
}

try {
  switch (cmd) {
    case "migrate": {
      const applied = await migrate(pool);
      console.log(JSON.stringify({ applied }));
      break;
    }
    case "seed": {
      await migrate(pool);
      const slug = arg("desk") ?? "demo";
      const out = await seedDesk(pool, slug, config.mode);
      await seedCatalog(pool);
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "catalog": {
      await seedCatalog(pool);
      console.log("catalog seeded");
      break;
    }
    case "import-card": {
      const ctx = await deskCtx(arg("desk") ?? "demo", "editor");
      const card = JSON.parse(readFileSync(arg("file")!, "utf8"));
      const { importCard } = await import("./modules/markets.ts");
      console.log(JSON.stringify(await importCard(pool, ctx, card)));
      break;
    }
    case "ingest": {
      const { ingestSource, ingestTick } = await import("./modules/ingest.ts");
      const policyId = arg("policy");
      if (policyId) {
        console.log(JSON.stringify(await ingestSource(pool, config, clock, policyId)));
      } else {
        await ingestTick(pool, config, clock);
        console.log("ingest tick complete");
      }
      break;
    }
    case "evaluate": {
      const ctx = await deskCtx(arg("desk") ?? "demo", "analyst");
      const { evaluate } = await import("./modules/evaluate.ts");
      console.log(
        JSON.stringify(
          await evaluate(pool, ctx, {
            ruleBindingId: arg("binding")!,
            asOf: arg("as-of") ? new Date(arg("as-of")!) : undefined,
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "research": {
      const { researchTick } = await import("./modules/research.ts");
      await researchTick(pool, clock);
      console.log("research tick complete");
      break;
    }
    case "dispatch": {
      const ctx = await deskCtx(arg("desk") ?? "demo", "editor");
      const { dispatchApproval } = await import("./modules/outbox.ts");
      console.log(
        JSON.stringify(await dispatchApproval(pool, ctx, config, arg("approval")!, arg("request-id"))),
      );
      break;
    }
    case "outbox": {
      const { outboxTick } = await import("./modules/outbox.ts");
      await outboxTick(pool, config, clock, `cli-${process.pid}`);
      console.log("outbox tick complete");
      break;
    }
    case "poll": {
      const { pollTick } = await import("./modules/outbox.ts");
      await pollTick(pool, config, clock);
      console.log("poll tick complete");
      break;
    }
    case "reconcile": {
      const { reconcileTick } = await import("./modules/recovery.ts");
      await reconcileTick(pool, config, clock);
      console.log("reconcile tick complete");
      break;
    }
    case "replay": {
      const ctx = await deskCtx(arg("desk") ?? "demo", "analyst");
      const fc = new FrozenClock(new Date(arg("as-of") ?? clock.now().toISOString()));
      const replayCtx = { ...ctx, clock: fc };
      const { evaluate } = await import("./modules/evaluate.ts");
      console.log(
        JSON.stringify(
          await evaluate(pool, replayCtx, {
            ruleBindingId: arg("binding")!,
            asOf: fc.now(),
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "export": {
      const ctx = await deskCtx(arg("desk") ?? "demo", "auditor");
      const { exportDesk } = await import("./modules/ops.ts");
      console.log(JSON.stringify(await exportDesk(pool, ctx), null, 2));
      break;
    }
    case "backup": {
      const { backupDesk } = await import("./modules/ops.ts");
      console.log(JSON.stringify(await backupDesk(pool, arg("desk") ?? "demo", arg("out") ?? `backups/${Date.now()}.json`)));
      break;
    }
    case "restore": {
      const { restoreDesk } = await import("./modules/ops.ts");
      // --replace required to overwrite an existing desk (destructive, explicit)
      console.log(JSON.stringify(await restoreDesk(
        pool, arg("file")!, arg("desk"), { replace: args.includes("--replace") })));
      break;
    }
    case "doctor": {
      const { doctor } = await import("./modules/ops.ts");
      console.log(JSON.stringify(await doctor(pool, config, clock), null, 2));
      break;
    }
    default:
      console.error(
        "commands: migrate seed catalog import-card ingest evaluate research dispatch outbox poll reconcile replay export backup restore doctor",
      );
      process.exit(2);
  }
} finally {
  await pool.end();
}
