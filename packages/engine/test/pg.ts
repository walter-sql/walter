import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import type { CdcSource, TxnHandler } from "../src/cdc/replication";

export const TEST_PG = process.env.WALTER_TEST_PG;

export const startCdc = (cdc: CdcSource, onTxn: TxnHandler) =>
  new Promise<string>(slot => cdc.start(onTxn, slot));

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_PG });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

export function ownDatabase(name: string): string | undefined {
  if (!TEST_PG) return undefined;
  const db = `walter_test_${name}`;
  beforeAll(async () => {
    await dropDatabase(db);
    await admin(`CREATE DATABASE ${db}`);
  });
  afterAll(() => dropDatabase(db));
  const url = new URL(TEST_PG);
  url.pathname = `/${db}`;
  return url.href;
}
