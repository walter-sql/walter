import pg from "pg";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll } from "vitest";
import type { CdcSource, TxnHandler } from "../src/cdc/replication";

export const TEST_PG = process.env.WALTER_TEST_PG;

export const startCdc = (cdc: CdcSource, onTxn: TxnHandler) =>
  new Promise<string>(slot => cdc.start(onTxn, slot));

export type LinkMode = "up" | "down" | "frozen";

export async function relay(pgUrl: string, mode: LinkMode = "up") {
  const target = new URL(pgUrl);
  const links = new Set<Socket>();
  const server = createServer(client => {
    if (mode === "down") return void client.destroy();
    const upstream = connect(Number(target.port) || 5432, target.hostname);
    client.pipe(upstream).pipe(client);
    for (const [s, other] of [
      [client, upstream],
      [upstream, client]
    ] as const) {
      links.add(s);
      if (mode === "frozen") s.pause();
      s.on("error", () => other.destroy());
      s.on("close", () => {
        links.delete(s);
        other.destroy();
      });
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = new URL(pgUrl);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    set(next: LinkMode) {
      mode = next;
      for (const s of links) {
        if (next === "down") s.destroy();
        else if (next === "frozen") s.pause();
        else s.resume();
      }
    },
    close: () =>
      new Promise<void>(r => {
        for (const s of links) s.destroy();
        server.close(() => r());
      })
  };
}

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
