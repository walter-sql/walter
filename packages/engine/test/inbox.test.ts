import { describe, it, expect } from "vitest";
import {
  SubscriptionManager,
  MAX_QUEUED_OPS
} from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { MemRowSource } from "../src/lazy/rowsource";
import { absorbedThrough } from "../src/lazy/snapshot";
import { LazyTree } from "../src/lazy/lazy-tree";
import { Stream } from "../src/lazy/stream";
import { initParser } from "../src/parser/parse";
import type { ViewSubscriber } from "../src/subscriptions/shape";
import { stableStringify, type Row } from "../src/ivm/zset";
import { StateStore } from "./state-store";
import {
  applyTxn,
  commit,
  compileShape,
  seedTree,
  viewToMap,
  withReads,
  type RowOp
} from "./support";

const TABLE = "public.users";

async function setup() {
  await initParser();
  const catalog = new SchemaCatalog();
  catalog.setKeyColumns(TABLE, ["id"]);
  catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
  catalog.setKeyColumns("public.comments", ["id"]);
  catalog.setColumnTypes("public.comments", { id: "int4", body: "text" });
  const data = new Map<string, Row[]>([[TABLE, [{ id: 1, name: "a" }]]]);
  return { catalog, data };
}

function collector() {
  const snapshots: Row[][] = [];
  const diffs: unknown[] = [];
  const sub: ViewSubscriber = {
    id: "s1",
    snapshot(rows) {
      snapshots.push(JSON.parse(rows));
    },
    diff(c) {
      diffs.push(JSON.parse(c));
    },
    failed() {
      throw new Error("shape failed");
    }
  };
  return { snapshots, diffs, sub };
}

describe("per-shape inbox", () => {
  it("a synchronous burst drains as one merged diff carrying the net change", async () => {
    const { catalog, data } = await setup();
    const source = new MemRowSource(t => data.get(t) ?? []);
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const { diffs, sub } = collector();
    await mgr.subscribe(sub, { sql: "SELECT id, name FROM users", params: [] });

    const upd = (name: string, old: string): RowOp[] => [
      {
        table: TABLE,
        kind: "update",
        newRow: { id: 1, name },
        oldRow: { id: 1, name: old }
      }
    ];
    void mgr.handleTxn(commit(20, upd("b", "a")));
    void mgr.handleTxn(commit(21, upd("c", "b")));
    void mgr.handleTxn(commit(22, upd("d", "c")));
    await mgr.settled();

    expect(diffs).toHaveLength(1);
    const body = JSON.stringify(diffs[0]);
    expect(body).toContain('"d"');
    expect(body).not.toContain('"b"');
  });

  it("an insert and its delete in one take cancel to no diff", async () => {
    const { catalog, data } = await setup();
    const source = new MemRowSource(t => data.get(t) ?? []);
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const { diffs, sub } = collector();
    await mgr.subscribe(sub, { sql: "SELECT id, name FROM users", params: [] });

    void mgr.handleTxn(
      commit(20, [
        { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
      ])
    );
    void mgr.handleTxn(
      commit(21, [
        { table: TABLE, kind: "delete", oldRow: { id: 2, name: "b" } }
      ])
    );
    await mgr.settled();

    expect(diffs).toHaveLength(0);
    expect(mgr.stats.backlog).toBe(0);
  });

  it("an initial load folds in the transactions its reads already covered", async () => {
    const { catalog } = await setup();
    const stream = new Stream();
    stream.issue = async () => 10n;
    const source = new MemRowSource(
      () => [],
      () => absorbedThrough(6)
    );
    const mgr = new SubscriptionManager(
      source,
      catalog,
      "public",
      30_000,
      stream
    );
    const { snapshots, diffs, sub } = collector();
    const subscribed = mgr.subscribe(sub, {
      sql: "SELECT id, name FROM users",
      params: []
    });
    await new Promise(r => setTimeout(r, 10));
    expect(snapshots).toHaveLength(0);

    const ghost = { id: 2, name: "ghost" };
    void mgr.handleTxn(
      commit(5, [{ table: TABLE, kind: "insert", newRow: ghost }])
    );
    void mgr.handleTxn(
      commit(6, [{ table: TABLE, kind: "delete", oldRow: ghost }])
    );
    stream.advance(10n);
    await subscribed;
    await mgr.settled();

    expect(snapshots).toEqual([[]]);
    expect(diffs).toHaveLength(0);
  });

  it("a shape stuck on a slow read never delays another shape's diff", async () => {
    const { catalog, data } = await setup();
    data.set("public.comments", [{ id: 1, body: "x" }]);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const inner = new MemRowSource(t => data.get(t) ?? []);
    const source = withReads(inner, {
      async scopedRows(...a) {
        if (a[0] === TABLE) await gate;
        return inner.scopedRows(...a);
      }
    });
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);

    const slow = collector();
    const fast = collector();
    const slowP = mgr.subscribe(slow.sub, {
      sql: "SELECT id, name FROM users",
      params: []
    });
    await new Promise(r => setTimeout(r, 10));
    await mgr.subscribe(fast.sub, {
      sql: "SELECT id, body FROM comments",
      params: []
    });

    void mgr.handleTxn(
      commit(20, [
        { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
      ])
    );
    void mgr.handleTxn(
      commit(21, [
        {
          table: "public.comments",
          kind: "insert",
          newRow: { id: 2, body: "y" }
        }
      ])
    );
    await new Promise(r => setTimeout(r, 10));

    expect(fast.diffs).toHaveLength(1);
    expect(slow.snapshots).toHaveLength(0);

    release();
    await slowP;
    await mgr.settled();
    expect(slow.snapshots).toHaveLength(1);
    expect(slow.diffs).toHaveLength(1);
  });

  it("ops queued behind a truncate never resurrect truncated rows", async () => {
    const { catalog, data } = await setup();
    const source = new MemRowSource(t => data.get(t) ?? []);
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const { snapshots, diffs, sub } = collector();
    await mgr.subscribe(sub, { sql: "SELECT id, name FROM users", params: [] });

    data.set(TABLE, []);
    void mgr.handleTxn(
      commit(20, [
        { table: TABLE, kind: "insert", newRow: { id: 5, name: "z" } }
      ])
    );
    void mgr.handleTxn(commit(21, [], [TABLE]));
    await mgr.settled();

    expect(diffs).toHaveLength(0);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual([]);
  });

  it("only the backlog cap makes handleTxn wait", async () => {
    const { catalog, data } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const inner = new MemRowSource(t => data.get(t) ?? []);
    const source = withReads(inner, {
      async scopedRows(...a) {
        await gate;
        return inner.scopedRows(...a);
      }
    });
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const { sub } = collector();
    const subP = mgr.subscribe(sub, {
      sql: "SELECT id, name FROM users",
      params: []
    });
    await new Promise(r => setTimeout(r, 10));

    const flood: RowOp[] = [];
    for (let i = 0; i < MAX_QUEUED_OPS + 1; i++) {
      flood.push({
        table: TABLE,
        kind: "insert",
        newRow: { id: 10 + i, name: "x" }
      });
    }
    let resolved = false;
    const held = mgr.handleTxn(commit(20, flood)).then(() => {
      resolved = true;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(mgr.stats.backlog).toBeGreaterThan(MAX_QUEUED_OPS);

    release();
    await subP;
    await held;
    expect(resolved).toBe(true);
    await mgr.settled();
    expect(mgr.stats.backlog).toBe(0);
  });
});

describe("merged batches", () => {
  it("each op reconciles by its own xid: absorbed ops skip, fresh ops apply", async () => {
    await initParser();
    const state = new StateStore();
    state.setKeyColumns("users", ["id"]);
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 1, name: "A" } }
    ]);

    const { shape } = await compileShape("SELECT id, name FROM users", [], {
      keyColumnsByTable: { users: ["id"] }
    });
    const source = new MemRowSource(
      t => state.rows(t),
      () => absorbedThrough(15)
    );
    const lazy = new LazyTree(shape, [], source);
    await seedTree(lazy);

    const out = await applyTxn(lazy, {
      position: 20n,
      ops: [
        {
          table: "users",
          xid: 10,
          kind: "update",
          newRow: { id: 1, name: "STALE" },
          oldRow: { id: 1 }
        },
        {
          table: "users",
          xid: 20,
          kind: "update",
          newRow: { id: 1, name: "B" },
          oldRow: { id: 1 }
        }
      ]
    });
    expect(out.length).toBeGreaterThan(0);
    expect([...viewToMap(lazy.materializer).values()]).toEqual([
      stableStringify({ id: 1, name: "B" })
    ]);
  });
});
