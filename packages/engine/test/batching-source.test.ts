import { describe, it, expect } from "vitest";
import {
  compileShape,
  recompute,
  viewToMap,
  mapsEqual,
  Rng,
  TEST_TYPES
} from "./support";
import { planShape } from "../src/planner/plan";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import { BatchingRowSource } from "../src/lazy/batching-source";
import { LazyTree } from "../src/lazy/lazy-tree";
import type { ShapeTreePlan } from "../src/planner/plan";
import type { ShapeQuery } from "../src/parser/ir";
import type { RowSource } from "../src/lazy/rowsource";
import {
  applyTxn,
  catalogOf,
  commit,
  seedTree,
  withReads,
  type RowOp
} from "./support";

const JOIN_PK = { users: ["id"], comments: ["id"] };
const SQL =
  "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1";
const OPTS = { columnTypes: TEST_TYPES, keyColumnsByTable: JOIN_PK };
const CATALOG = catalogOf(OPTS);

async function parseShape(): Promise<ShapeQuery> {
  return (await compileShape(SQL, [1], OPTS)).query;
}

class CountingSource {
  whereIn = 0;
  whereInValues = 0;
  readonly source: RowSource;
  constructor(inner: MemRowSource) {
    this.source = withReads(inner, {
      fetchWhereIn: (table, columns, keys) => {
        this.whereIn++;
        this.whereInValues += keys.length;
        return inner.fetchWhereIn(table, columns, keys);
      }
    });
  }
}

async function makeShape(
  room: number,
  source: RowSource,
  query: ShapeQuery
): Promise<LazyTree> {
  const shape: ShapeTreePlan = planShape(query, [room], CATALOG);
  const lazy = new LazyTree(shape, [room], source);
  await seedTree(lazy);
  return lazy;
}

describe("BatchingRowSource: cross-shape coalescing", () => {
  it("fans N shapes' gap fetches for one WAL frame into one query per table", async () => {
    const query = await parseShape();
    const ROOMS = 6;
    const state = new StateStore();
    for (const [t, cols] of Object.entries(JOIN_PK))
      state.setKeyColumns(t, cols);

    const initial: RowOp[] = [];
    for (let u = 1; u <= 10 + ROOMS; u++)
      initial.push({
        table: "users",
        kind: "insert",
        newRow: { id: u, name: `u${u}` }
      });
    for (let r = 1; r <= ROOMS; r++)
      initial.push({
        table: "comments",
        kind: "insert",
        newRow: { id: r, user_id: 1, room_id: r, body: "x" }
      });
    state.ingest(initial);

    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const source = new BatchingRowSource(counting.source, CATALOG);

    const shapes: LazyTree[] = [];
    for (let r = 1; r <= ROOMS; r++)
      shapes.push(await makeShape(r, source, query));

    const ops: RowOp[] = [];
    for (let r = 1; r <= ROOMS; r++)
      ops.push({
        table: "comments",
        kind: "insert",
        newRow: { id: 100 + r, user_id: 10 + r, room_id: r, body: "y" }
      });
    state.ingest(ops);

    const before = counting.whereIn;
    await Promise.all(shapes.map(s => applyTxn(s, commit(1000, ops))));
    const fetchesForFrame = counting.whereIn - before;

    expect(fetchesForFrame).toBe(1); // not ROOMS
    expect(counting.whereInValues).toBeGreaterThanOrEqual(ROOMS); // union covered all

    for (let i = 0; i < shapes.length; i++) {
      const room = i + 1;
      const diff = mapsEqual(
        viewToMap(shapes[i]!.materializer),
        recompute(query, [room], OPTS, state)
      );
      expect(diff, `room ${room}: ${diff}`).toBeUndefined();
    }
  });

  it("de-duplicates overlapping values across shapes into a single union", async () => {
    const query = await parseShape();
    const state = new StateStore();
    for (const [t, cols] of Object.entries(JOIN_PK))
      state.setKeyColumns(t, cols);
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 7, name: "shared" } },
      { table: "users", kind: "insert", newRow: { id: 1, name: "u1" } },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 1, user_id: 1, room_id: 1, body: "x" }
      },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 2, user_id: 1, room_id: 2, body: "x" }
      }
    ]);

    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const source = new BatchingRowSource(counting.source, CATALOG);
    const shapes = [
      await makeShape(1, source, query),
      await makeShape(2, source, query)
    ];

    const ops: RowOp[] = [
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 101, user_id: 7, room_id: 1, body: "y" }
      },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 102, user_id: 7, room_id: 2, body: "y" }
      }
    ];
    state.ingest(ops);

    const before = counting.whereIn;
    const beforeValues = counting.whereInValues;
    await Promise.all(shapes.map(s => applyTxn(s, commit(2000, ops))));

    expect(counting.whereIn - before).toBe(1); // one users query
    expect(counting.whereInValues - beforeValues).toBe(1); // value 7 sent once

    for (const [i, room] of [1, 2].entries()) {
      const diff = mapsEqual(
        viewToMap(shapes[i]!.materializer),
        recompute(query, [room], OPTS, state)
      );
      expect(diff, `room ${room}: ${diff}`).toBeUndefined();
    }
  });

  it("editing a row never re-reads a join partner already in memory", async () => {
    const query = await parseShape();
    const state = new StateStore();
    for (const [t, cols] of Object.entries(JOIN_PK))
      state.setKeyColumns(t, cols);
    const comment = (body: string) => ({
      id: 1,
      user_id: 7,
      room_id: 1,
      body
    });
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 7, name: "Ann" } },
      { table: "comments", kind: "insert", newRow: comment("v0") }
    ]);
    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const shape = await makeShape(1, counting.source, query);

    const before = counting.whereIn;
    for (let i = 1; i <= 3; i++) {
      const ops: RowOp[] = [
        {
          table: "comments",
          kind: "update",
          oldRow: comment(`v${i - 1}`),
          newRow: comment(`v${i}`)
        }
      ];
      state.ingest(ops);
      await applyTxn(shape, commit(10 + i, ops));
    }

    expect(counting.whereIn - before).toBe(0);
    const diff = mapsEqual(
      viewToMap(shape.materializer),
      recompute(query, [1], OPTS, state)
    );
    expect(diff).toBeUndefined();
  });
});

class JoinModel {
  private readonly ids = new Map<string, number[]>();
  private seq = 0;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }
  private make(table: string): Record<string, unknown> {
    const id = ++this.seq;
    if (table === "users")
      return { id, name: this.rng.pick(["Ann", "Bo", "Cy", "Dee"]) };
    return {
      id,
      user_id: 1 + this.rng.int(8),
      room_id: 1 + this.rng.int(4),
      body: this.rng.pick(["x", "y", "z"])
    };
  }
  private track(table: string, id: number): void {
    let arr = this.ids.get(table);
    if (!arr) this.ids.set(table, (arr = []));
    arr.push(id);
  }
  private existing(table: string): number | undefined {
    const arr = this.ids.get(table);
    if (!arr || arr.length === 0) return undefined;
    return arr[this.rng.int(arr.length)];
  }
  private forget(table: string, id: number): void {
    const arr = this.ids.get(table);
    if (arr) {
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  randomOp(table: string): RowOp | undefined {
    const roll = this.rng.next();
    const id = this.existing(table);
    if (roll < 0.55 || id === undefined) {
      const newRow = this.make(table);
      this.track(table, newRow.id as number);
      return { table, kind: "insert", newRow };
    }
    if (roll < 0.85) {
      const newRow = { ...this.make(table), id };
      return { table, kind: "update", newRow, oldRow: { id } };
    }
    this.forget(table, id);
    return { table, kind: "delete", oldRow: { id } };
  }
}

describe("BatchingRowSource: concurrent shapes stay correct", () => {
  it("scoped+batched incremental == full recompute across many shapes", async () => {
    const query = await parseShape();
    for (const seed of [5, 99, 7777]) {
      const rng = new Rng(seed);
      const model = new JoinModel(rng);
      const state = new StateStore();
      for (const [t, cols] of Object.entries(JOIN_PK))
        state.setKeyColumns(t, cols);

      const initial: RowOp[] = [];
      for (let i = 0; i < 20; i++)
        for (const t of ["users", "comments"] as const) {
          const op = model.randomOp(t);
          if (op?.kind === "insert") initial.push(op);
        }
      state.ingest(initial);

      const source = new BatchingRowSource(
        new MemRowSource(t => state.rows(t)),
        CATALOG
      );
      const rooms = [1, 2, 3, 4];
      const shapes = await Promise.all(
        rooms.map(r => makeShape(r, source, query))
      );

      for (const [i, room] of rooms.entries()) {
        const diff = mapsEqual(
          viewToMap(shapes[i]!.materializer),
          recompute(query, [room], OPTS, state)
        );
        expect(
          diff,
          `seed=${seed} room=${room} after-seed: ${diff}`
        ).toBeUndefined();
      }

      for (let txn = 0; txn < 120; txn++) {
        const ops: RowOp[] = [];
        const n = 1 + rng.int(5);
        for (let i = 0; i < n; i++) {
          const op = model.randomOp(rng.pick(["users", "comments"]));
          if (op) ops.push(op);
        }
        state.ingest(ops);
        const batch = commit(txn + 1, ops);
        await Promise.all(shapes.map(s => applyTxn(s, batch)));

        for (const [i, room] of rooms.entries()) {
          const diff = mapsEqual(
            viewToMap(shapes[i]!.materializer),
            recompute(query, [room], OPTS, state)
          );
          expect(
            diff,
            `seed=${seed} room=${room} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    }
  });
});
