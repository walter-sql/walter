import { describe, it, expect, afterEach } from "vitest";
import WebSocket, { type WebSocketServer } from "ws";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { WalterServer } from "../src/server/server";
import {
  INSTANCE_HEADER,
  ShapeRouter,
  ownerOf,
  shapeKey,
  type ShapeSubscriber
} from "../src/subscriptions/cluster";
import type {
  ShapeRequest,
  SubscriptionManager
} from "../src/subscriptions/manager";
import { SqlParseError } from "../src/parser/ir";
import { EngineClient, WalterError } from "@walter-sql/client";
import type { ServerMessage } from "@walter-sql/view";

const key = (sql: string) => shapeKey({ sql, params: [] });

const race = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms)
    )
  ]);

const until = (cond: () => boolean, ms = 3000) =>
  race(
    new Promise<void>(resolve => {
      const tick = setInterval(() => {
        if (cond()) {
          clearInterval(tick);
          resolve();
        }
      }, 10);
    }),
    ms
  );

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

function fakeLocal(failWith?: Error) {
  const subs = new Map<string, ShapeSubscriber>();
  const state = { subscribes: 0 };
  const manager = {
    subscribe: async (sub: ShapeSubscriber, req: ShapeRequest) => {
      if (failWith) throw failWith;
      state.subscribes++;
      subs.set(sub.id, sub);
      sub.snapshot(JSON.stringify([{ sql: req.sql }]));
      return {};
    },
    unsubscribe: (_shape: unknown, subId: string) => void subs.delete(subId)
  } as unknown as SubscriptionManager;
  return {
    manager,
    subs,
    state,
    push(frame: { rows?: unknown[]; changes?: unknown[]; failed?: true }) {
      for (const sub of subs.values()) {
        if (frame.rows) sub.snapshot(JSON.stringify(frame.rows));
        if (frame.changes) sub.diff(JSON.stringify(frame.changes));
        if (frame.failed) sub.failed();
      }
    }
  };
}

let instanceSeq = 0;

async function node(opts: {
  manager?: SubscriptionManager;
  peers?: string[];
  grace?: number;
  port?: number;
}) {
  const router = new ShapeRouter(
    opts.manager,
    opts.peers ?? [],
    `i${++instanceSeq}`,
    undefined,
    opts.grace ?? 0
  );
  const server = new WalterServer(router, opts.port ?? 0, "127.0.0.1");
  await server.listen();
  const port = (
    (server as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo
  ).port;
  cleanups.push(async () => {
    router.dispose();
    await server.close();
  });
  return { router, server, url: `ws://127.0.0.1:${port}` };
}

function reservePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function proxy(url: string) {
  const client = new EngineClient(url);
  cleanups.push(() => client.close());
  return client;
}

function rawClient(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const inbox: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.on("message", data => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  const open = new Promise<void>(resolve => ws.on("open", resolve));
  cleanups.push(() => ws.terminate());
  return {
    open,
    inbox,
    next: () =>
      race(
        new Promise<ServerMessage>(resolve => {
          const queued = inbox.shift();
          if (queued) resolve(queued);
          else waiters.push(resolve);
        })
      ),
    send: (msg: unknown) => ws.send(JSON.stringify(msg))
  };
}

describe("ownerOf", () => {
  const peers = ["ws://a:1", "ws://b:1", "ws://c:1"];

  it("is deterministic and order-independent", () => {
    for (let i = 0; i < 200; i++) {
      const k = key(`SELECT ${i} FROM t`);
      const owner = ownerOf(k, peers);
      expect(ownerOf(k, [...peers].reverse())).toBe(owner);
      expect(ownerOf(k, peers)).toBe(owner);
    }
  });

  it("remaps ~1/N of shapes when a peer joins", () => {
    const grown = [...peers, "ws://d:1"];
    let moved = 0;
    for (let i = 0; i < 1000; i++) {
      const k = key(`SELECT ${i} FROM t`);
      if (ownerOf(k, peers) !== ownerOf(k, grown)) moved++;
    }
    expect(moved).toBeGreaterThan(150);
    expect(moved).toBeLessThan(350);
  });
});

describe("cluster routing", () => {
  it("serves locally with no peers configured", async () => {
    const local = fakeLocal();
    const a = await node({ manager: local.manager });
    expect(await race(proxy(a.url).snapshot({ sql: "SELECT 1" }))).toEqual([
      { sql: "SELECT 1" }
    ]);
  });

  it("relays from the owner and collapses local demand to one upstream sub", async () => {
    const local = fakeLocal();
    const a = await node({ manager: local.manager });
    const b = await node({ peers: [a.url], grace: 0 });
    const client = proxy(b.url);

    const first: ServerMessage[] = [];
    const second: ServerMessage[] = [];
    client.subscribe({ sql: "SELECT 1" }, msg => first.push(msg));
    await until(() => first.length === 1);
    expect(first[0]).toMatchObject({
      type: "snapshot",
      rows: [{ sql: "SELECT 1" }]
    });

    client.subscribe({ sql: "SELECT 1" }, msg => second.push(msg));
    await until(() => second.length === 1);
    expect(second[0]).toMatchObject({
      type: "snapshot",
      rows: [{ sql: "SELECT 1" }]
    });
    expect(local.state.subscribes).toBe(1);
    expect(b.router.stats).toEqual({ relayShapes: 1, relaySubscribers: 2 });

    local.push({ changes: [{ op: "add", value: { sql: "x" } }] });
    await until(() => first.length === 2 && second.length === 2);
    expect(first[1]).toMatchObject({ type: "diff" });

    const third = await race(client.snapshot({ sql: "SELECT 1" }));
    expect(third).toEqual([{ sql: "SELECT 1" }, { sql: "x" }]);
    expect(local.state.subscribes).toBe(1);
  });

  it("passes failed through, greets late joiners with it, and heals", async () => {
    const local = fakeLocal();
    const a = await node({ manager: local.manager });
    const b = await node({ peers: [a.url], grace: 0 });
    const client = proxy(b.url);

    const seen: ServerMessage[] = [];
    client.subscribe({ sql: "SELECT 1" }, msg => seen.push(msg));
    await until(() => seen.length === 1);

    local.push({ failed: true });
    await until(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ type: "failed" });

    const late: ServerMessage[] = [];
    client.subscribe({ sql: "SELECT 1" }, msg => late.push(msg));
    await until(() => late.length === 1);
    expect(late[0]).toMatchObject({ type: "failed" });

    local.push({ rows: [{ ok: true }] });
    await until(() => late.length === 2);
    expect(late[1]).toMatchObject({ type: "snapshot", rows: [{ ok: true }] });
  });

  it("propagates a refusal verbatim and leaves no zombie subscription", async () => {
    const local = fakeLocal(new SqlParseError("syntax error at or near"));
    const a = await node({ manager: local.manager });
    const b = await node({ peers: [a.url], grace: 0 });

    const raw = rawClient(b.url);
    await raw.open;
    raw.send({ type: "subscribe", shapeId: "s", sql: "SELEC", params: [] });
    expect(await raw.next()).toMatchObject({
      type: "error",
      shapeId: "s",
      code: "parse_error",
      message: "syntax error at or near"
    });
    await until(() => b.router.stats.relayShapes === 0);

    raw.send({ type: "subscribe", shapeId: "s", sql: "SELEC", params: [] });
    expect(await raw.next()).toMatchObject({
      type: "error",
      code: "parse_error"
    });
  });

  it("streams reject with the relayed code", async () => {
    const local = fakeLocal(new SqlParseError("nope"));
    const a = await node({ manager: local.manager });
    const b = await node({ peers: [a.url], grace: 0 });
    const failure = race(proxy(b.url).snapshot({ sql: "SELEC" })).catch(e => e);
    const err = (await failure) as WalterError;
    expect(err).toBeInstanceOf(WalterError);
    expect(err.code).toBe("parse_error");
  });

  it("always maintains peer subscribes; without credentials that refuses loudly", async () => {
    const a = await node({ peers: ["ws://127.0.0.1:1"] });
    const peer = rawClient(a.url, { [INSTANCE_HEADER]: "someone-else" });
    await peer.open;
    peer.send({ type: "subscribe", shapeId: "p", sql: "SELECT 1", params: [] });
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "internal",
      message: expect.stringContaining("WALTER_PG")
    });
  });

  it("resolves itself in the peer list and serves directly", async () => {
    const port = await reservePort();
    const local = fakeLocal();
    const c = await node({
      manager: local.manager,
      peers: [`ws://127.0.0.1:${port}`],
      port
    });
    const client = proxy(c.url);
    expect(await race(client.snapshot({ sql: "SELECT 7" }))).toEqual([
      { sql: "SELECT 7" }
    ]);
    expect(await race(client.snapshot({ sql: "SELECT 8" }))).toEqual([
      { sql: "SELECT 8" }
    ]);
    expect(c.router.stats.relayShapes).toBe(0);
  });

  it("parks subscribes while the owner is down; early unsubscribes never strand the successor", async () => {
    const port = await reservePort();
    const b = await node({ peers: [`ws://127.0.0.1:${port}`], grace: 0 });

    const raw = rawClient(b.url);
    await raw.open;
    raw.send({ type: "subscribe", shapeId: "s", sql: "SELECT 1", params: [] });
    raw.send({ type: "unsubscribe", shapeId: "s" });
    raw.send({ type: "subscribe", shapeId: "s", sql: "SELECT 1", params: [] });

    const local = fakeLocal();
    await node({ manager: local.manager, port });

    expect(await raw.next()).toMatchObject({
      type: "snapshot",
      shapeId: "s",
      rows: [{ sql: "SELECT 1" }]
    });
    await until(() => local.subs.size === 1);
    expect(raw.inbox).toHaveLength(0);
  });

  it("a dead owner never blocks other shapes on the same connection", async () => {
    const deadPort = await reservePort();
    const port = await reservePort();
    const local = fakeLocal();
    const self = `ws://127.0.0.1:${port}`;
    const dead = `ws://127.0.0.1:${deadPort}`;
    const d = await node({ manager: local.manager, peers: [self, dead], port });

    let ownedByDead = "";
    let ownedBySelf = "";
    for (let i = 0; !ownedByDead || !ownedBySelf; i++) {
      const sql = `SELECT ${i} FROM t`;
      if (ownerOf(key(sql), [self, dead]) === dead) ownedByDead ||= sql;
      else ownedBySelf ||= sql;
    }

    const raw = rawClient(d.url);
    await raw.open;
    raw.send({
      type: "subscribe",
      shapeId: "parked",
      sql: ownedByDead,
      params: []
    });
    raw.send({
      type: "subscribe",
      shapeId: "live",
      sql: ownedBySelf,
      params: []
    });
    expect(await raw.next()).toMatchObject({
      type: "snapshot",
      shapeId: "live"
    });
    expect(raw.inbox).toHaveLength(0);
  });

  it("reuses the upstream subscription within the grace window", async () => {
    const local = fakeLocal();
    const a = await node({ manager: local.manager });
    const b = await node({ peers: [a.url], grace: 150 });
    const client = proxy(b.url);

    const seen: ServerMessage[] = [];
    const off = client.subscribe({ sql: "SELECT 1" }, msg => seen.push(msg));
    await until(() => seen.length === 1);
    off();
    const again: ServerMessage[] = [];
    client.subscribe({ sql: "SELECT 1" }, msg => again.push(msg));
    await until(() => again.length === 1);
    expect(local.state.subscribes).toBe(1);

    client.close();
    await until(() => local.subs.size === 0, 2000);
  });
});
