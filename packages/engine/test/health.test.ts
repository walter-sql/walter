import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import type { WebSocketServer } from "ws";
import pg from "pg";
import { EngineClient } from "@walter-sql/client";
import type { ServerMessage } from "@walter-sql/view";
import { WalterServer, type ServerHealth } from "../src/server/server";
import { WalterEngine } from "../src/server/engine";
import { ShapeRouter } from "../src/subscriptions/cluster";
import { ownDatabase, relay } from "./pg";

const CONN = ownDatabase("health");

const stubRouter = () => new ShapeRouter(undefined, [], "test", undefined, 0);

const boundPort = (server: WalterServer): number =>
  ((server as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo)
    .port;

const get = (port: number, path: string, headers?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });

async function waitFor(
  cond: () => Promise<boolean>,
  what: string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("health endpoints", () => {
  it("routes live, ready, and metrics", async () => {
    let ready = true;
    const health: ServerHealth = {
      ready: () => ready,
      metrics: () => "walter_up 1\n"
    };
    const server = new WalterServer(
      stubRouter(),
      0,
      "127.0.0.1",
      undefined,
      health
    );
    await server.listen();
    const port = boundPort(server);

    expect((await get(port, "/live")).status).toBe(200);
    expect((await get(port, "/ready")).status).toBe(200);
    ready = false;
    expect((await get(port, "/ready")).status).toBe(503);
    expect((await get(port, "/live")).status).toBe(200);

    const metrics = await get(port, "/metrics");
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toBe("walter_up 1\n");

    expect((await get(port, "/nope")).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/live`, { method: "POST" })).status
    ).toBe(405);
    await server.close();
  });

  it("gates /metrics behind the secret; probes stay open", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1", "s3cret", {
      ready: () => true,
      metrics: () => "walter_up 1\n"
    });
    await server.listen();
    const port = boundPort(server);

    expect((await get(port, "/live")).status).toBe(200);
    expect((await get(port, "/ready")).status).toBe(200);
    expect((await get(port, "/metrics")).status).toBe(401);
    expect(
      (await get(port, "/metrics", { authorization: "Bearer wrong" })).status
    ).toBe(401);
    expect(
      (await get(port, "/metrics", { authorization: "Bearer s3cret" })).status
    ).toBe(200);
    await server.close();
  });
});

describe.skipIf(!CONN)("engine health wiring", () => {
  it("/ready flips 503 on stream loss and heals", async () => {
    const engine = new WalterEngine({ pg: CONN!, port: 0 });
    const admin = new pg.Client({ connectionString: CONN });
    await admin.connect();
    try {
      await engine.start();
      const port = boundPort(engine.server);
      const status = async (path: string) => (await get(port, path)).status;

      expect(await status("/live")).toBe(200);
      await waitFor(async () => (await status("/ready")) === 200, "ready");
      const metrics = await (await get(port, "/metrics")).text();
      expect(metrics).toContain("walter_replication_connected 1");

      const pid = (
        engine.cdc as unknown as { service: { _client: { processID: number } } }
      ).service._client.processID;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);

      await waitFor(async () => (await status("/ready")) === 503, "ready 503");
      expect(await status("/live")).toBe(200);
      expect(await (await get(port, "/metrics")).text()).toContain(
        "walter_replication_connected 0"
      );

      await waitFor(async () => (await status("/ready")) === 200, "recovery");
    } finally {
      await engine.stop();
      await admin.end();
    }
  }, 30_000);

  it("boots with Postgres unreachable, holds subscriptions, heals", async () => {
    const link = await relay(CONN!, "down");
    const admin = new pg.Client({ connectionString: CONN });
    await admin.connect();
    await admin.query("CREATE TABLE boot_t (id int PRIMARY KEY)");
    const engine = new WalterEngine({ pg: link.url, port: 0 });
    let client: EngineClient | undefined;
    try {
      await engine.start();
      const port = boundPort(engine.server);
      const status = async (path: string) => (await get(port, path)).status;
      expect(await status("/live")).toBe(200);
      expect(await status("/ready")).toBe(503);

      client = new EngineClient(`ws://127.0.0.1:${port}`);
      const seen: ServerMessage[] = [];
      client.subscribe({ sql: "SELECT id FROM boot_t" }, m => seen.push(m));
      await new Promise(r => setTimeout(r, 1500));
      expect(seen).toEqual([]);
      expect(await status("/ready")).toBe(503);

      link.set("up");
      await waitFor(async () => (await status("/ready")) === 200, "ready");
      await waitFor(async () => seen.length === 1, "snapshot");
      expect(seen[0]).toMatchObject({ type: "snapshot", rows: [] });
    } finally {
      client?.close();
      await engine.stop();
      await admin.end();
      await link.close();
    }
  }, 30_000);
});
