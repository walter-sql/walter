#!/usr/bin/env node
import { z } from "zod";
import { WalterEngine } from "../server/engine";
import { log } from "../util/log";

const commaList = z.string().transform(t =>
  t
    .split(",")
    .map(t => t.trim())
    .filter(Boolean)
);

const Env = z.object({
  WALTER_PG: z.url().optional(),
  WALTER_PORT: z.coerce.number().int().positive().optional(),
  WALTER_HOST: z.string().optional(),
  WALTER_SECRET: z.string().optional(),
  WALTER_DEFAULT_SCHEMA: z.string().optional(),
  WALTER_TABLES: commaList.optional(),
  WALTER_PEERS: commaList.pipe(z.array(z.url())).optional(),
  WALTER_GRACE_TTL_MS: z.coerce.number().nonnegative().optional()
});

async function main(): Promise<void> {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      log.error(`${issue.path.join(".") || "env"}: ${issue.message}`);
    }
    process.exit(1);
  }
  const env = parsed.data;
  if (!env.WALTER_PG && !env.WALTER_PEERS?.length) {
    log.error(
      "set WALTER_PG (to maintain shapes) and/or WALTER_PEERS (to relay them)"
    );
    process.exit(1);
  }
  const engine = new WalterEngine({
    pg: env.WALTER_PG,
    port: env.WALTER_PORT,
    host: env.WALTER_HOST,
    secret: env.WALTER_SECRET,
    defaultSchema: env.WALTER_DEFAULT_SCHEMA,
    tables: env.WALTER_TABLES,
    peers: env.WALTER_PEERS,
    graceTtlMs: env.WALTER_GRACE_TTL_MS
  });

  const shutdown = async () => {
    await engine.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The CDC layer self-heals; a transient library rejection must not exit.
  process.on("unhandledRejection", reason => {
    log.error({ err: reason }, "unhandled rejection");
  });

  await engine.start();
}

main().catch(e => {
  log.fatal({ err: e }, "fatal");
  process.exit(1);
});
