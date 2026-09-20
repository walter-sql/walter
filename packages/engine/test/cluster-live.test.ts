import { describe, it, expect, afterEach } from "vitest";
import pg from "pg";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { WalterEngine } from "../src/server/engine";
import { ownerOf, shapeKey } from "../src/subscriptions/cluster";
import { EngineClient } from "@walter-sql/client";
import type { ServerMessage } from "@walter-sql/view";
import { ownDatabase } from "./pg";

const CONN = ownDatabase("cluster_live");
const SQL = "SELECT id, v FROM cluster_t ORDER BY id";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

function reservePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(cond: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe.skipIf(!CONN)("cluster over live Postgres", () => {
  it("relays a live shape from its owner and heals an owner restart", async () => {
    const admin = new pg.Client({ connectionString: CONN });
    await admin.connect();
    cleanups.push(() => admin.end());
    await admin.query("DROP TABLE IF EXISTS cluster_t");
    await admin.query("CREATE TABLE cluster_t (id int PRIMARY KEY, v text)");
    cleanups.push(async () => {
      await admin.query("DROP TABLE IF EXISTS cluster_t");
    });

    const ports = [await reservePort(), await reservePort()];
    const peers = ports.map(p => `ws://127.0.0.1:${p}`);
    const boot = (port: number) => {
      const engine = new WalterEngine({
        pg: CONN!,
        port,
        peers,
        graceTtlMs: 0
      });
      cleanups.push(() => engine.stop().catch(() => {}));
      return engine;
    };
    const engines = ports.map(boot);
    await Promise.all(engines.map(e => e.start()));

    const owner = ownerOf(shapeKey({ sql: SQL, params: [] }), peers);
    const ownerIdx = peers.indexOf(owner);
    const relayIdx = 1 - ownerIdx;

    const client = new EngineClient(peers[relayIdx]!);
    cleanups.push(() => client.close());
    const seen: ServerMessage[] = [];
    client.subscribe({ sql: SQL }, msg => seen.push(msg));

    await waitFor(() => seen.length === 1, "initial snapshot");
    expect(seen[0]).toMatchObject({ type: "snapshot", rows: [] });
    expect(engines[relayIdx]!.router.stats.relayShapes).toBe(1);
    expect(engines[ownerIdx]!.manager!.stats.shapes).toBe(1);

    await admin.query("INSERT INTO cluster_t VALUES (1, 'a')");
    await waitFor(() => seen.length === 2, "relayed diff");
    expect(seen[1]).toMatchObject({ type: "diff" });

    await engines[ownerIdx]!.stop();
    await admin.query("INSERT INTO cluster_t VALUES (2, 'b')");

    const revived = boot(ports[ownerIdx]!);
    await revived.start();
    await waitFor(
      () => seen.some(m => m.type === "snapshot" && m.rows.length === 2),
      "healed snapshot",
      30_000
    );
    const healed = seen.filter(m => m.type === "snapshot").pop()!;
    expect(healed).toMatchObject({
      type: "snapshot",
      rows: [
        { id: 1, v: "a" },
        { id: 2, v: "b" }
      ]
    });
  }, 60_000);
});
