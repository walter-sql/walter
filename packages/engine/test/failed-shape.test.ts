import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TreeMaterializer,
  ResultKeyCollisionError
} from "../src/subscriptions/materializer";
import { zsetFromRows, type Row } from "../src/ivm/zset";
import { compileShape } from "./support";
import { SubscriptionManager } from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { MemRowSource } from "../src/lazy/rowsource";
import { absorbedThrough } from "../src/lazy/snapshot";
import { StateStore } from "./state-store";
import { initParser } from "../src/parser/parse";
import { commit, withReads, type RowOp } from "./support";
import { ShapeRuntime, type ViewSubscriber } from "../src/subscriptions/shape";
import type { LazyTree } from "../src/lazy/lazy-tree";
import type { AppliedOps } from "../src/cdc/types";

const TABLE = "public.users";

afterEach(() => {
  vi.useRealTimers();
});

describe("result-key collisions (materializer)", () => {
  const OPTS = { keyColumnsByTable: { users: ["id"] } };
  async function misKeyedShape() {
    const { shape } = await compileShape(
      "SELECT id, name FROM users",
      [],
      OPTS
    );
    shape.root.keyColumns = ["name"];
    return shape;
  }

  it("throws instead of silently picking an arbitrary row", async () => {
    const shape = await misKeyedShape();
    const mat = new TreeMaterializer(shape);
    expect(() =>
      mat.apply(
        new Map([
          [
            shape.root,
            zsetFromRows([
              { id: 1, name: "a" },
              { id: 2, name: "a" }
            ])
          ]
        ])
      )
    ).toThrow(ResultKeyCollisionError);
  });

  it("shows weight > 1 on one content as that many copies", async () => {
    const shape = await misKeyedShape();
    const mat = new TreeMaterializer(shape);
    const z = zsetFromRows([{ id: 1, name: "a" }], 2);
    expect(() => mat.apply(new Map([[shape.root, z]]))).not.toThrow();
    expect(mat.snapshot()).toHaveLength(2);
  });
});

describe("failed shapes (live error state, scheduled recovery)", () => {
  it("applies a transaction committed during the recovery seed to the fresh tree", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let release = (): void => {};
    const applied: AppliedOps[] = [];
    const makeTree = () => {
      const n = ++attempt;
      return {
        materializer: { snapshot: () => [] },
        workingSetSize: 0,
        fence: async () => undefined,
        flush: () => [],
        load: async () => {
          if (n === 1) throw new Error("boom");
          await new Promise<void>(r => (release = r));
        },
        absorb: async (b: AppliedOps) => {
          applied.push(b);
        }
      } as unknown as LazyTree;
    };
    const rt = new ShapeRuntime(
      "fp",
      "SELECT 1",
      { root: {} as never, tables: ["t"] },
      makeTree
    );
    await rt.seeded;
    expect(rt.failedBy).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toBe(2);
    const ingested = rt.ingest(
      commit(5, [{ table: "t", kind: "insert", newRow: { id: 1 } }])
    );
    release();
    await ingested;
    expect(rt.failedBy).toBeUndefined();
    expect(applied).toHaveLength(1);
  });

  function collector() {
    const snapshots: Row[][] = [];
    const diffs: unknown[] = [];
    let failures = 0;
    const sub = (id: string): ViewSubscriber => ({
      id,
      snapshot(rows) {
        snapshots.push(JSON.parse(rows));
      },
      diff(c) {
        diffs.push(JSON.parse(c));
      },
      failed() {
        failures++;
      }
    });
    return { snapshots, diffs, failures: () => failures, sub };
  }

  async function setup() {
    await initParser();
    const state = new StateStore();
    state.setKeyColumns(TABLE, ["id"]);
    state.ingest([
      { table: TABLE, kind: "insert", newRow: { id: 1, name: "a" } },
      { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
    ]);
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
    let reads = 0;
    const source = new MemRowSource(
      t => {
        reads++;
        return state.rows(t);
      },
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    return { state, mgr, reads: () => reads };
  }

  async function failViaCollision(
    mgr: SubscriptionManager,
    state: StateStore,
    sub: ViewSubscriber
  ) {
    const shape = await mgr.subscribe(sub, {
      sql: "SELECT id, name FROM users",
      params: []
    });
    shape.compiled.root.keyColumns = ["name"];
    const collide: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 3, name: "dup" } },
      { table: TABLE, kind: "insert", newRow: { id: 4, name: "dup" } }
    ];
    state.ingest(collide);
    await mgr.handleTxn(commit(20, collide));
    await mgr.settled();
    return shape;
  }

  it("fails subscribers once, stays registered, skips further WAL", async () => {
    vi.useFakeTimers();
    const { state, mgr } = await setup();
    const { diffs, failures, sub } = collector();
    const shape = await failViaCollision(mgr, state, sub("s1"));

    expect(failures()).toBe(1);
    expect(shape.failedBy).toBeInstanceOf(ResultKeyCollisionError);
    expect(mgr.stats.shapes).toBe(1);
    expect(mgr.stats.failedShapes).toBe(1);
    expect(shape.subscribers.size).toBe(1);
    expect(shape.workingSetSize).toBe(0);

    const diffsBefore = diffs.length;
    await mgr.handleTxn(
      commit(30, [
        { table: TABLE, kind: "insert", newRow: { id: 5, name: "z" } }
      ])
    );
    expect(diffs.length).toBe(diffsBefore);
    expect(failures()).toBe(1);
  });

  it("recovers on the scheduled rebuild: fresh snapshot, no client action", async () => {
    vi.useFakeTimers();
    const { state, mgr } = await setup();
    const { snapshots, diffs, failures, sub } = collector();
    await failViaCollision(mgr, state, sub("s1"));
    expect(snapshots).toHaveLength(1);

    const fix: RowOp[] = [
      { table: TABLE, kind: "delete", oldRow: { id: 4, name: "dup" } }
    ];
    state.ingest(fix);
    await mgr.handleTxn(commit(40, fix));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mgr.stats.failedShapes).toBe(0);
    expect(mgr.stats.shapes).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toHaveLength(3);

    const revive: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 6, name: "f" } }
    ];
    state.ingest(revive);
    await mgr.handleTxn(commit(50, revive));
    await mgr.settled();
    expect(diffs).toHaveLength(1);
    expect(failures()).toBe(1);
  });

  it("retries are paced by a doubling delay, not by WAL volume", async () => {
    vi.useFakeTimers();
    const { state, mgr, reads } = await setup();
    const { sub } = collector();
    await failViaCollision(mgr, state, sub("s1"));
    const afterFail = reads();

    for (let xid = 100; xid < 110; xid++) {
      await mgr.handleTxn(
        commit(xid, [
          { table: TABLE, kind: "insert", newRow: { id: xid, name: "x" } }
        ])
      );
    }
    expect(reads()).toBe(afterFail);

    await vi.advanceTimersByTimeAsync(999);
    expect(reads()).toBe(afterFail);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(afterFail + 1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reads()).toBe(afterFail + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(afterFail + 2);
    expect(mgr.stats.failedShapes).toBe(1);
  });

  it("a subscriber attaching to a failed shape is errored, kept, recovered", async () => {
    vi.useFakeTimers();
    const { state, mgr, reads } = await setup();
    const first = collector();
    const shape = await failViaCollision(mgr, state, first.sub("s1"));
    const beforeAttach = reads();

    const late = collector();
    await mgr.subscribe(late.sub("s2"), {
      sql: "SELECT id, name FROM users",
      params: []
    });
    expect(late.failures()).toBe(1);
    expect(late.snapshots).toHaveLength(0);
    expect(shape.subscribers.size).toBe(2);
    expect(reads()).toBe(beforeAttach);

    const fix: RowOp[] = [
      { table: TABLE, kind: "delete", oldRow: { id: 4, name: "dup" } }
    ];
    state.ingest(fix);
    await mgr.handleTxn(commit(40, fix));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.snapshots).toHaveLength(2);
    expect(late.snapshots).toHaveLength(1);
  });

  it("a failed first seed registers the failed shape; subscribe resolves", async () => {
    vi.useFakeTimers();
    await initParser();
    const state = new StateStore();
    state.setKeyColumns(TABLE, ["id"]);
    state.ingest([
      { table: TABLE, kind: "insert", newRow: { id: 1, name: "a" } }
    ]);
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
    let broken = true;
    let seeds = 0;
    const source = new MemRowSource(
      t => {
        seeds++;
        if (broken) throw new Error("seed boom");
        return state.rows(t);
      },
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);

    const first = collector();
    const shape = await mgr.subscribe(first.sub("s1"), {
      sql: "SELECT id, name FROM users",
      params: []
    });
    expect(first.failures()).toBe(1);
    expect(shape.failedBy?.message).toBe("seed boom");
    expect(mgr.stats.shapes).toBe(1);
    expect(mgr.stats.failedShapes).toBe(1);

    const late = collector();
    await mgr.subscribe(late.sub("s2"), {
      sql: "SELECT id, name FROM users",
      params: []
    });
    expect(late.failures()).toBe(1);
    expect(seeds).toBe(1);

    broken = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.stats.failedShapes).toBe(0);
    expect(first.snapshots).toHaveLength(1);
    expect(late.snapshots).toHaveLength(1);
    expect(first.snapshots[0]).toHaveLength(1);
  });
});

describe("TRUNCATE = reset in place (data event, not failure)", () => {
  const COMMENTS = "public.comments";

  async function setup() {
    await initParser();
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
    catalog.setKeyColumns(COMMENTS, ["id"]);
    catalog.setColumnTypes(COMMENTS, { id: "int4", body: "text" });
    const data = new Map<string, Row[]>([
      [
        TABLE,
        [
          { id: 1, name: "a" },
          { id: 2, name: "b" }
        ]
      ],
      [COMMENTS, [{ id: 1, body: "hi" }]]
    ]);
    const source = new MemRowSource(
      t => data.get(t) ?? [],
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const sub = (id: string, snapshots: Row[][], failures: string[]) =>
      ({
        id,
        snapshot(rows) {
          snapshots.push(JSON.parse(rows));
        },
        diff() {},
        failed() {
          failures.push(id);
        }
      }) satisfies ViewSubscriber;
    return { data, mgr, sub };
  }

  it("re-snapshots affected shapes, fails nobody, keeps them registered", async () => {
    const { data, mgr, sub } = await setup();
    const userSnaps: Row[][] = [];
    const commentSnaps: Row[][] = [];
    const failures: string[] = [];
    await mgr.subscribe(sub("u", userSnaps, failures), {
      sql: "SELECT id, name FROM users",
      params: []
    });
    await mgr.subscribe(sub("c", commentSnaps, failures), {
      sql: "SELECT id, body FROM comments",
      params: []
    });
    expect(userSnaps).toHaveLength(1);
    expect(userSnaps[0]).toHaveLength(2);

    data.set(TABLE, []);
    mgr.handleTxn(commit(20, [], [TABLE]));
    await new Promise(r => setTimeout(r, 20));

    expect(failures).toHaveLength(0);
    expect(userSnaps).toHaveLength(2);
    expect(userSnaps[1]).toHaveLength(0);
    expect(commentSnaps).toHaveLength(1);
    expect(mgr.stats.shapes).toBe(2);

    const revived: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 3, name: "c" } }
    ];
    data.set(TABLE, [{ id: 3, name: "c" }]);
    mgr.handleTxn(commit(30, revived));
    await new Promise(r => setTimeout(r, 20));
    expect(failures).toHaveLength(0);
    expect(mgr.stats.shapes).toBe(2);
  });

  it("a failed reseed fails the shape; it stays and recovers", async () => {
    vi.useFakeTimers();
    const { data, mgr, sub } = await setup();
    const snapshots: Row[][] = [];
    const failures: string[] = [];
    const shape = await mgr.subscribe(sub("u", snapshots, failures), {
      sql: "SELECT id, name FROM users",
      params: []
    });

    const rows = data.get.bind(data);
    const boom = new Error("reseed boom");
    data.get = () => {
      throw boom;
    };
    await mgr.handleTxn(commit(20, [], [TABLE]));
    await mgr.settled();

    expect(failures).toEqual(["u"]);
    expect(shape.failedBy).toBe(boom);
    expect(snapshots).toHaveLength(1);
    expect(mgr.stats.shapes).toBe(1);
    expect(mgr.stats.failedShapes).toBe(1);

    data.get = rows;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.stats.failedShapes).toBe(0);
    expect(snapshots).toHaveLength(2);
  });
});

describe("resetAll (stream recovery = reseed in place)", () => {
  it("re-snapshots every subscriber, no errors, registry intact", async () => {
    await initParser();
    const state = new StateStore();
    state.setKeyColumns(TABLE, ["id"]);
    state.ingest([
      { table: TABLE, kind: "insert", newRow: { id: 1, name: "a" } }
    ]);
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
    const source = new MemRowSource(
      t => state.rows(t),
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);

    const failures: string[] = [];
    const snapshots: string[] = [];
    const sub = (id: string): ViewSubscriber => ({
      id,
      snapshot() {
        snapshots.push(id);
      },
      diff() {},
      failed() {
        failures.push(id);
      }
    });
    await mgr.subscribe(sub("s1"), { sql: "SELECT id FROM users", params: [] });
    await mgr.subscribe(sub("s2"), {
      sql: "SELECT id, name FROM users",
      params: []
    });
    expect(snapshots).toEqual(["s1", "s2"]);
    expect(mgr.stats.shapes).toBe(2);

    mgr.resetAll();
    await new Promise(r => setTimeout(r, 20));

    expect(failures).toHaveLength(0);
    expect(snapshots.slice(2).sort()).toEqual(["s1", "s2"]);
    expect(mgr.stats.shapes).toBe(2);
  });
});

describe("handleTxn backpressure (resolves under the cap, never on applies)", () => {
  async function setup() {
    await initParser();
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
    const data = new Map<string, Row[]>([[TABLE, [{ id: 1, name: "a" }]]]);
    return { catalog, data };
  }

  it("resolves without waiting for applies; settled() waits for broadcast", async () => {
    const { catalog, data } = await setup();
    const source = new MemRowSource(
      t => data.get(t) ?? [],
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    const order: string[] = [];
    await mgr.subscribe(
      {
        id: "s1",
        snapshot() {},
        diff() {
          order.push("diff");
        },
        failed() {}
      },
      { sql: "SELECT id, name FROM users", params: [] }
    );

    const ops: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
    ];
    data.set(TABLE, [...data.get(TABLE)!, { id: 2, name: "b" }]);
    await mgr.handleTxn(commit(20, ops));
    order.push("resolved");
    await mgr.settled();
    order.push("settled");
    expect(order).toEqual(["resolved", "diff", "settled"]);
  });

  it("a failing apply resolves (the failed state is the recovery, never a rejection)", async () => {
    vi.useFakeTimers();
    const { catalog, data } = await setup();
    const source = new MemRowSource(
      t => data.get(t) ?? [],
      () => absorbedThrough(10)
    );
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);
    let failures = 0;
    const shape = await mgr.subscribe(
      {
        id: "s1",
        snapshot() {},
        diff() {},
        failed() {
          failures++;
        }
      },
      { sql: "SELECT id, name FROM users", params: [] }
    );
    shape.compiled.root.keyColumns = ["name"];

    const collide: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 3, name: "dup" } },
      { table: TABLE, kind: "insert", newRow: { id: 4, name: "dup" } }
    ];
    await mgr.handleTxn(commit(20, collide));
    await mgr.settled();
    expect(failures).toBe(1);
    expect(mgr.stats.shapes).toBe(1);
    expect(mgr.stats.failedShapes).toBe(1);
  });

  it("a mid-seed shape never gates the stream", async () => {
    const { catalog, data } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const inner = new MemRowSource(
      t => data.get(t) ?? [],
      () => absorbedThrough(10)
    );
    const source = withReads(inner, {
      async scopedRows(...a) {
        await gate;
        return inner.scopedRows(...a);
      }
    });
    const mgr = new SubscriptionManager(source, catalog, "public", 30_000);

    const snapshots: Row[][] = [];
    const diffs: unknown[] = [];
    const subP = mgr.subscribe(
      {
        id: "s1",
        snapshot(rows) {
          snapshots.push(JSON.parse(rows));
        },
        diff(c) {
          diffs.push(JSON.parse(c));
        },
        failed() {}
      },
      { sql: "SELECT id, name FROM users", params: [] }
    );
    await new Promise(r => setTimeout(r, 10));
    expect(snapshots).toHaveLength(0);

    const ops: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
    ];
    await mgr.handleTxn(commit(20, ops));
    expect(snapshots).toHaveLength(0);

    release();
    await subP;
    await new Promise(r => setTimeout(r, 10));
    expect(snapshots).toHaveLength(1);
    expect(diffs).toHaveLength(1);
  });
});
