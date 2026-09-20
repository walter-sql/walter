import { describe, it, expect } from "vitest";
import {
  compileShape,
  recompute,
  viewToMap,
  mapsEqual,
  withReads,
  Rng
} from "./support";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import type { RowSource } from "../src/lazy/rowsource";
import { LazyTree } from "../src/lazy/lazy-tree";
import { keysetAfterSql, orderBySql } from "../src/lazy/pg-source";
import type { WindowSortKey } from "../src/lazy/window";
import type { ShapeQuery } from "../src/parser/ir";
import {
  applyTxn,
  commit,
  seedTree,
  type CatalogSpec,
  type RowOp
} from "./support";
import type { Row } from "../src/ivm/zset";

function exactAgainstRecompute(
  lazy: LazyTree,
  query: ShapeQuery,
  state: StateStore,
  params: unknown[],
  opts: CatalogSpec
): void {
  expect(
    mapsEqual(
      viewToMap(lazy.materializer),
      recompute(query, params, opts, state)
    )
  ).toBeUndefined();
}

const PK = { item: ["id"] };
const ITEM_TYPES = {
  item: {
    id: "int4",
    room: "text",
    score: "int4",
    name: "text",
    body: "text",
    payload: "jsonb"
  }
};

class CountingSource {
  pagedReads = 0;
  readonly source: RowSource;

  constructor(inner: MemRowSource) {
    this.source = withReads(inner, {
      fetchWindow: req => {
        this.pagedReads++;
        return inner.fetchWindow(req);
      }
    });
  }
}

class Model {
  readonly ids: number[] = [];
  private seq = 0;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  fields(): Row {
    return {
      room: this.rng.pick(["r1", "r2"]),
      score: this.rng.next() < 0.15 ? null : this.rng.int(10),
      name: this.rng.pick(["Ann", "bob", "Ä", "zoé", "Bob", "ann"]),
      body: this.rng.pick(["x", "y"])
    };
  }

  insert(): RowOp {
    const id = ++this.seq;
    this.ids.push(id);
    return { table: "item", kind: "insert", newRow: { id, ...this.fields() } };
  }

  randomOp(): RowOp | undefined {
    const roll = this.rng.next();
    const id =
      this.ids.length > 0 ? this.ids[this.rng.int(this.ids.length)] : undefined;
    if (roll < 0.45 || id === undefined) return this.insert();
    if (roll < 0.75) {
      return {
        table: "item",
        kind: "update",
        newRow: { id, ...this.fields() },
        oldRow: { id }
      };
    }
    const i = this.ids.indexOf(id!);
    if (i >= 0) this.ids.splice(i, 1);
    return { table: "item", kind: "delete", oldRow: { id } };
  }
}

interface Tpl {
  name: string;
  sql: string;
  params: unknown[];
}

const TEMPLATES: Tpl[] = [
  {
    name: "int key desc (nulls first by default)",
    sql: "SELECT id, score FROM item WHERE room = $1 ORDER BY score DESC LIMIT 4",
    params: ["r1"]
  },
  {
    name: "text key asc, byte order",
    sql: "SELECT id, name FROM item WHERE room = $1 ORDER BY name ASC LIMIT 5",
    params: ["r1"]
  },
  {
    name: "two keys + offset",
    sql: "SELECT id, score, name FROM item WHERE room = $1 ORDER BY score ASC NULLS FIRST, name DESC LIMIT 3 OFFSET 2",
    params: ["r1"]
  },
  {
    name: "LIMIT/OFFSET as params (plan-time constants)",
    sql: "SELECT id, score, name FROM item WHERE room = $1 ORDER BY score ASC NULLS FIRST, name DESC LIMIT $2 OFFSET $3",
    params: ["r1", 3, 2]
  }
];

describe("windowed shapes: bounded incremental == full recompute", () => {
  for (const tpl of TEMPLATES) {
    it(tpl.name, async () => {
      for (const seed of [2, 19, 9001]) {
        const rng = new Rng(seed);
        const model = new Model(rng);
        const state = new StateStore();
        state.setKeyColumns("item", PK.item);

        const initial: RowOp[] = [];
        for (let i = 0; i < 60; i++) initial.push(model.insert());
        state.ingest(initial);

        const opts = {
          keyColumnsByTable: PK,
          columnTypes: ITEM_TYPES
        };
        const { query, shape } = await compileShape(tpl.sql, tpl.params, opts);
        const source = new MemRowSource(t => state.rows(t));
        const lazy = new LazyTree(shape, tpl.params, source);
        expect(
          lazy.window,
          "pushdown must engage for this shape"
        ).toBeDefined();
        await seedTree(lazy);

        expect(lazy.workingSetSize).toBeLessThanOrEqual(lazy.window!.pageSize);

        let diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(query, tpl.params, opts, state)
        );
        expect(
          diff,
          `${tpl.name} seed=${seed} after-seed: ${diff}`
        ).toBeUndefined();

        for (let txn = 0; txn < 250; txn++) {
          const ops: RowOp[] = [];
          for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
            const op = model.randomOp();
            if (op) ops.push(op);
          }
          state.ingest(ops);
          await applyTxn(lazy, commit(txn + 1, ops));

          diff = mapsEqual(
            viewToMap(lazy.materializer),
            recompute(query, tpl.params, opts, state)
          );
          expect(
            diff,
            `${tpl.name} seed=${seed} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    });
  }
});

describe("window refill", () => {
  it("stays bounded under inserts ahead of the cursor (a live feed)", async () => {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);
    const seedRows: RowOp[] = [];
    for (let i = 1; i <= 50; i++)
      seedRows.push({
        table: "item",
        kind: "insert",
        newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
      });
    state.ingest(seedRows);
    const sql =
      "SELECT id, score FROM item WHERE room = $1 ORDER BY score DESC, id ASC LIMIT 3";
    const opts = { keyColumnsByTable: PK, columnTypes: ITEM_TYPES };
    const { query, shape } = await compileShape(sql, ["r1"], opts);
    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const lazy = new LazyTree(shape, ["r1"], counting.source);
    await seedTree(lazy);
    const pageSize = lazy.window!.pageSize;
    for (let i = 51; i <= 550; i++) {
      const ops: RowOp[] = [
        {
          table: "item",
          kind: "insert",
          newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
        }
      ];
      state.ingest(ops);
      await applyTxn(lazy, commit(i, ops));
      expect(lazy.workingSetSize).toBeLessThanOrEqual(pageSize);
      if (i % 50 === 0) {
        const diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(query, ["r1"], opts, state)
        );
        expect(diff, `i=${i}: ${diff}`).toBeUndefined();
      }
    }
    expect(counting.pagedReads).toBe(1);
    const top = [...state.rows("item")]
      .sort((a, b) => (b.score as number) - (a.score as number))
      .slice(0, 3);
    const ops: RowOp[] = top.map(r => ({
      table: "item",
      kind: "delete" as const,
      oldRow: { id: r.id }
    }));
    state.ingest(ops);
    await applyTxn(lazy, commit(1000, ops));
    expect(
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, ["r1"], opts, state)
      )
    ).toBeUndefined();
  });

  it("survives the whole window being deleted, repeatedly, staying bounded", async () => {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);

    const rows: Row[] = [];
    for (let i = 1; i <= 120; i++) {
      rows.push({ id: i, room: "r1", score: i, name: `n${i}`, body: "x" });
    }
    state.ingest(
      rows.map(r => ({ table: "item", kind: "insert" as const, newRow: r }))
    );

    const sql =
      "SELECT id, score FROM item WHERE room = $1 ORDER BY score ASC LIMIT 5";
    const opts = {
      keyColumnsByTable: PK,
      columnTypes: ITEM_TYPES
    };
    const { query, shape } = await compileShape(sql, ["r1"], opts);
    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const lazy = new LazyTree(shape, ["r1"], counting.source);
    await seedTree(lazy);
    expect(counting.pagedReads).toBe(1);

    let txn = 0;
    for (let round = 0; round < 15; round++) {
      const alive = [...state.rows("item")]
        .sort((a, b) => (a.score as number) - (b.score as number))
        .slice(0, 5);
      const ops: RowOp[] = alive.map(r => ({
        table: "item",
        kind: "delete" as const,
        oldRow: { id: r.id }
      }));
      state.ingest(ops);
      await applyTxn(lazy, commit(++txn, ops));

      const diff = mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, ["r1"], opts, state)
      );
      expect(diff, `round=${round}: ${diff}`).toBeUndefined();
      expect(lazy.workingSetSize).toBeLessThanOrEqual(
        2 * lazy.window!.pageSize
      );
    }
    expect(counting.pagedReads).toBeGreaterThan(1);
  });

  it("ignores inserts beyond the cursor: working set stays ~page-sized as the table grows", async () => {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);
    const initial: RowOp[] = [];
    for (let i = 1; i <= 30; i++) {
      initial.push({
        table: "item",
        kind: "insert",
        newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
      });
    }
    state.ingest(initial);

    const sql =
      "SELECT id, score FROM item WHERE room = $1 ORDER BY score ASC LIMIT 5";
    const opts = {
      keyColumnsByTable: PK,
      columnTypes: ITEM_TYPES
    };
    const { query, shape } = await compileShape(sql, ["r1"], opts);
    const source = new MemRowSource(t => state.rows(t));
    const lazy = new LazyTree(shape, ["r1"], source);
    await seedTree(lazy);
    const seeded = lazy.workingSetSize;

    for (let txn = 1; txn <= 500; txn++) {
      const id = 1000 + txn;
      const ops: RowOp[] = [
        {
          table: "item",
          kind: "insert",
          newRow: {
            id,
            room: "r1",
            score: 1000 + txn,
            name: `n${id}`,
            body: "x"
          }
        }
      ];
      state.ingest(ops);
      await applyTxn(lazy, commit(txn, ops));
    }
    expect(lazy.workingSetSize).toBe(seeded);
    const diff = mapsEqual(
      viewToMap(lazy.materializer),
      recompute(query, ["r1"], opts, state)
    );
    expect(diff).toBeUndefined();
  });
});

describe("windowed page (ORDER BY + LIMIT + OFFSET) shifts on hidden changes", () => {
  const sql =
    "SELECT id, score FROM item WHERE room = $1 ORDER BY score ASC LIMIT 3 OFFSET 2";
  const opts = {
    keyColumnsByTable: PK,
    columnTypes: ITEM_TYPES
  };

  async function build() {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);
    const initial: RowOp[] = [];
    for (let i = 1; i <= 60; i++) {
      initial.push({
        table: "item",
        kind: "insert",
        newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
      });
    }
    state.ingest(initial);
    const { query, shape } = await compileShape(sql, ["r1"], opts);
    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const lazy = new LazyTree(shape, ["r1"], counting.source);
    await seedTree(lazy);
    return { state, query, lazy, counting };
  }

  const pageIds = (lazy: LazyTree): unknown[] =>
    lazy.materializer.snapshot().map(r => r.id);
  const exact = (lazy: LazyTree, query: ShapeQuery, state: StateStore): void =>
    exactAgainstRecompute(lazy, query, state, ["r1"], opts);

  it("seed shows the page and keeps only one page resident", async () => {
    const { lazy, counting } = await build();
    expect(pageIds(lazy)).toEqual([3, 4, 5]);
    expect(counting.pagedReads).toBe(1);
    expect(lazy.workingSetSize).toBeLessThanOrEqual(lazy.window!.pageSize);
  });

  it("insert before the offset: one row enters at the top, one leaves at the bottom", async () => {
    const { state, query, lazy, counting } = await build();
    const before = lazy.workingSetSize;
    const ops: RowOp[] = [
      {
        table: "item",
        kind: "insert",
        newRow: { id: 100, room: "r1", score: 0, name: "n100", body: "x" }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(pageIds(lazy)).toEqual([2, 3, 4]);
    exact(lazy, query, state);
    expect(lazy.workingSetSize).toBeLessThanOrEqual(lazy.window!.pageSize);
    expect(lazy.workingSetSize).toBeGreaterThanOrEqual(before);
    expect(counting.pagedReads).toBe(1);
  });

  it("delete before the offset: the page shifts the other way", async () => {
    const { state, query, lazy } = await build();
    const ops: RowOp[] = [{ table: "item", kind: "delete", oldRow: { id: 1 } }];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(pageIds(lazy)).toEqual([4, 5, 6]);
    exact(lazy, query, state);
  });

  it("update reordering a visible row to before the offset drops it from the page", async () => {
    const { state, query, lazy } = await build();
    const ops: RowOp[] = [
      {
        table: "item",
        kind: "update",
        newRow: { id: 4, room: "r1", score: 0, name: "n4", body: "x" },
        oldRow: { id: 4 }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(pageIds(lazy)).toEqual([2, 3, 5]);
    exact(lazy, query, state);
  });

  it("update reordering a hidden before-offset row into the page", async () => {
    const { state, query, lazy } = await build();
    const ops: RowOp[] = [
      {
        table: "item",
        kind: "update",
        newRow: { id: 2, room: "r1", score: 4, name: "n2", body: "x" },
        oldRow: { id: 2 }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(pageIds(lazy)).toEqual([2, 4, 5]);
    exact(lazy, query, state);
  });

  it("deleting most of the resident page forces a bounded keyset refill", async () => {
    const { state, query, lazy, counting } = await build();
    const ops: RowOp[] = [];
    for (let id = 1; id <= 19; id++)
      ops.push({ table: "item", kind: "delete", oldRow: { id } });
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(pageIds(lazy)).toEqual([22, 23, 24]);
    exact(lazy, query, state);
    expect(counting.pagedReads).toBe(2);
    expect(lazy.workingSetSize).toBeLessThanOrEqual(2 * lazy.window!.pageSize);
  });

  it("an offset past the end is an empty page that fills as rows arrive", async () => {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);
    const seed: RowOp[] = [];
    for (let i = 1; i <= 4; i++)
      seed.push({
        table: "item",
        kind: "insert",
        newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
      });
    state.ingest(seed);
    const bigOffset =
      "SELECT id, score FROM item WHERE room = $1 ORDER BY score ASC LIMIT 3 OFFSET 10";
    const { query, shape } = await compileShape(bigOffset, ["r1"], opts);
    const lazy = new LazyTree(
      shape,
      ["r1"],
      new MemRowSource(t => state.rows(t))
    );
    await seedTree(lazy);
    expect(lazy.materializer.snapshot()).toEqual([]);
    expect(
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, ["r1"], opts, state)
      )
    ).toBeUndefined();

    const more: RowOp[] = [];
    for (let i = 5; i <= 16; i++)
      more.push({
        table: "item",
        kind: "insert",
        newRow: { id: i, room: "r1", score: i, name: `n${i}`, body: "x" }
      });
    state.ingest(more);
    await applyTxn(lazy, commit(1, more));
    expect(lazy.materializer.snapshot().map(r => r.id)).toEqual([11, 12, 13]);
    expect(
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, ["r1"], opts, state)
      )
    ).toBeUndefined();
  });
});

describe("windowed top-k is total via the PK tiebreak", () => {
  const sql =
    "SELECT id, score FROM item WHERE room = $1 ORDER BY score DESC LIMIT 5";
  const opts = {
    keyColumnsByTable: PK,
    columnTypes: ITEM_TYPES
  };
  const oracle = (state: StateStore): number[] =>
    [...state.rows("item")]
      .filter(r => r.room === "r1")
      .sort(
        (a, b) =>
          (b.score as number) - (a.score as number) ||
          (a.id as number) - (b.id as number)
      )
      .slice(0, 5)
      .map(r => r.id as number);

  it("ties far exceeding the slack still yield the PK-smallest rows", async () => {
    const state = new StateStore();
    state.setKeyColumns("item", PK.item);
    const initial: RowOp[] = [];
    for (let id = 1; id <= 30; id++) {
      initial.push({
        table: "item",
        kind: "insert",
        newRow: { id, room: "r1", score: 5, name: `n${id}`, body: "x" }
      });
    }
    state.ingest(initial);

    const { shape } = await compileShape(sql, ["r1"], opts);
    const lazy = new LazyTree(
      shape,
      ["r1"],
      new MemRowSource(t => state.rows(t))
    );
    expect(lazy.window).toBeDefined();
    await seedTree(lazy);
    expect(lazy.workingSetSize).toBeLessThan(30);

    expect(lazy.materializer.snapshot().map(r => r.id)).toEqual(oracle(state));

    const ops: RowOp[] = [
      { table: "item", kind: "delete", oldRow: { id: 1 } },
      { table: "item", kind: "delete", oldRow: { id: 2 } }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(lazy.materializer.snapshot().map(r => r.id)).toEqual(oracle(state));
  });
});

const NEST_PK = { rooms: ["id"], comments: ["id"] };
const NEST_TYPES = {
  rooms: { id: "int4", title: "text", rank: "int4", space: "text" },
  comments: { id: "int4", room_id: "int4", body: "text" }
};

describe("windowed nested shape (anchor LEFT JOIN dim, GROUP BY anchor pk)", () => {
  it("pages rooms, pulls their comments by closure, refills on delete", async () => {
    const rng = new Rng(31);
    const state = new StateStore();
    for (const [t, cols] of Object.entries(NEST_PK))
      state.setKeyColumns(t, cols);

    const initial: RowOp[] = [];
    for (let i = 1; i <= 40; i++) {
      initial.push({
        table: "rooms",
        kind: "insert",
        newRow: { id: i, title: `t${i}`, rank: rng.int(100), space: "s1" }
      });
    }
    for (let i = 1; i <= 120; i++) {
      initial.push({
        table: "comments",
        kind: "insert",
        newRow: { id: i, room_id: 1 + rng.int(40), body: `b${i}` }
      });
    }
    state.ingest(initial);

    const sql =
      "SELECT r.id AS id, r.title AS title, " +
      "coalesce(json_agg(json_build_object('id', c.id, 'body', c.body) ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL), '[]') AS comments " +
      "FROM rooms r LEFT JOIN comments c ON c.room_id = r.id " +
      "WHERE r.space = $1 GROUP BY r.id, r.title ORDER BY r.rank ASC LIMIT 6";
    const opts = {
      keyColumnsByTable: NEST_PK,
      columnTypes: NEST_TYPES
    };
    const { query, shape } = await compileShape(sql, ["s1"], opts);
    const source = new MemRowSource(t => state.rows(t));
    const lazy = new LazyTree(shape, ["s1"], source);
    expect(lazy.window).toBeDefined();
    await seedTree(lazy);

    let diff = mapsEqual(
      viewToMap(lazy.materializer),
      recompute(query, ["s1"], opts, state)
    );
    expect(diff, `after-seed: ${diff}`).toBeUndefined();

    let txn = 0;
    for (let round = 0; round < 120; round++) {
      const roll = rng.next();
      const ops: RowOp[] = [];
      if (roll < 0.3) {
        const alive = [...state.rows("rooms")].sort(
          (a, b) => (a.rank as number) - (b.rank as number)
        );
        const victim = alive[rng.int(Math.min(6, alive.length))];
        if (victim) {
          ops.push({
            table: "rooms",
            kind: "delete",
            oldRow: { id: victim.id }
          });
        }
      } else if (roll < 0.6) {
        ops.push({
          table: "comments",
          kind: "insert",
          newRow: {
            id: 1000 + round,
            room_id: 1 + rng.int(40),
            body: `n${round}`
          }
        });
      } else if (roll < 0.8) {
        ops.push({
          table: "rooms",
          kind: "insert",
          newRow: {
            id: 100 + round,
            title: `new${round}`,
            rank: rng.int(100),
            space: "s1"
          }
        });
      } else {
        const all = [...state.rows("comments")];
        const victim = all[rng.int(Math.max(1, all.length))];
        if (victim) {
          ops.push({
            table: "comments",
            kind: "delete",
            oldRow: { id: victim.id }
          });
        }
      }
      if (ops.length === 0) continue;
      state.ingest(ops);
      await applyTxn(lazy, commit(++txn, ops));

      diff = mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, ["s1"], opts, state)
      );
      expect(diff, `round=${round}: ${diff}`).toBeUndefined();
    }
  });
});

describe("pushdown guards (ineligible shapes stay correct, just unwindowed)", () => {
  const GUARD_CASES: { name: string; sql: string; params: unknown[] }[] = [
    {
      name: "no LIMIT",
      sql: "SELECT id, score FROM item WHERE room = $1 ORDER BY score",
      params: ["r1"]
    },
    {
      name: "LIMIT without ORDER BY",
      sql: "SELECT id FROM item WHERE room = $1 LIMIT 5",
      params: ["r1"]
    },
    {
      name: "ORDER BY expression",
      sql: "SELECT id, score FROM item WHERE room = $1 ORDER BY score + 1 LIMIT 5",
      params: ["r1"]
    },
    {
      name: "DISTINCT",
      sql: "SELECT DISTINCT name AS name FROM item WHERE room = $1 ORDER BY name LIMIT 5",
      params: ["r1"]
    },
    {
      name: "LIMIT $n bound to NULL (no bound, as in Postgres)",
      sql: "SELECT id, score FROM item WHERE room = $1 ORDER BY score LIMIT $2",
      params: ["r1", null]
    }
  ];

  for (const c of GUARD_CASES) {
    it(`${c.name}: window disabled`, async () => {
      const { shape } = await compileShape(c.sql, c.params, {
        keyColumnsByTable: PK,
        columnTypes: ITEM_TYPES
      });
      const state = new StateStore();
      state.setKeyColumns("item", PK.item);
      const lazy = new LazyTree(
        shape,
        c.params,
        new MemRowSource(t => state.rows(t))
      );
      expect(lazy.window).toBeUndefined();
    });
  }

  it("LIMIT $n bound to a non-integer: rejected at planning", async () => {
    for (const bad of [2.5, -1, "ten"]) {
      await expect(
        compileShape(
          "SELECT id FROM item WHERE room = $1 ORDER BY score LIMIT $2",
          ["r1", bad],
          { keyColumnsByTable: PK, columnTypes: ITEM_TYPES }
        )
      ).rejects.toThrow(/LIMIT \$2 must be a non-negative integer/);
    }
  });

  it("anchor on a LEFT JOIN's nullable side: window disabled, view exact", async () => {
    const types = {
      users: { id: "int4", name: "text" },
      comments: { id: "int4", user_id: "int4", score: "int4" }
    };
    const pk = { users: ["id"], comments: ["id"] };
    const sql =
      "SELECT u.id AS uid, c.id AS cid, c.score AS score FROM users u LEFT JOIN comments c ON c.user_id = u.id WHERE u.id = $1 ORDER BY c.score ASC LIMIT 10";
    const opts = { keyColumnsByTable: pk, columnTypes: types };
    const { query, shape } = await compileShape(sql, [1], opts);
    expect(shape.root.window).toBeUndefined();
    const state = new StateStore();
    state.setKeyColumns("users", pk.users);
    state.setKeyColumns("comments", pk.comments);
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 1, name: "one" } }
    ]);
    const lazy = new LazyTree(shape, [1], new MemRowSource(t => state.rows(t)));
    await seedTree(lazy);
    expect(
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, [1], opts, state)
      )
    ).toBeUndefined();
  });

  it("ORDER BY a column of unclassifiable type: rejected at planning", async () => {
    await expect(
      compileShape(
        "SELECT id FROM item WHERE room = $1 ORDER BY payload LIMIT 5",
        ["r1"],
        { keyColumnsByTable: PK, columnTypes: ITEM_TYPES }
      )
    ).rejects.toThrow(/cannot order by/);
  });
});

describe("joined windows: bounded incremental == full recompute", () => {
  const JOIN_PK = { users: ["id"], comments: ["id"] };
  const JOIN_TYPES = {
    users: { id: "int4", name: "text" },
    comments: { id: "int4", user_id: "int4", room_id: "int4", score: "int4" }
  };
  const CASES: { name: string; sql: string; params: unknown[] }[] = [
    {
      name: "INNER JOIN to a partner (a join miss shrinks the window)",
      sql:
        "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id " +
        "WHERE c.room_id = $1 ORDER BY c.id LIMIT 5",
      params: [1]
    },
    {
      name: "WHERE on the partner side (a partner change reveals/conceals)",
      sql:
        "SELECT c.id AS id FROM comments c LEFT JOIN users u ON u.id = c.user_id " +
        "WHERE c.room_id = $1 AND u.name = $2 ORDER BY c.id LIMIT 5",
      params: [1, "Ann"]
    },
    {
      name: "ORDER BY a partner column (sort key not on the anchor)",
      sql:
        "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id " +
        "WHERE c.room_id = $1 ORDER BY u.name ASC LIMIT 4",
      params: [1]
    }
  ];

  for (const tc of CASES) {
    it(tc.name, async () => {
      for (const seed of [5, 23]) {
        const rng = new Rng(seed);
        const state = new StateStore();
        for (const [t, cols] of Object.entries(JOIN_PK))
          state.setKeyColumns(t, cols);

        const names = ["Ann", "bob", "Ä", "zoé", null];
        const initial: RowOp[] = [];
        for (let u = 1; u <= 8; u++)
          initial.push({
            table: "users",
            kind: "insert",
            newRow: { id: u, name: names[rng.int(names.length)] }
          });
        let nextId = 0;
        for (let i = 0; i < 40; i++)
          initial.push({
            table: "comments",
            kind: "insert",
            newRow: {
              id: ++nextId,
              user_id: 1 + rng.int(10), // some miss: no such user
              room_id: 1 + rng.int(2),
              score: rng.int(20)
            }
          });
        state.ingest(initial);

        const opts = { keyColumnsByTable: JOIN_PK, columnTypes: JOIN_TYPES };
        const { query, shape } = await compileShape(tc.sql, tc.params, opts);
        const lazy = new LazyTree(
          shape,
          tc.params,
          new MemRowSource(t => state.rows(t))
        );
        expect(lazy.window, "window must engage for this shape").toBeDefined();
        await seedTree(lazy);

        let diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(query, tc.params, opts, state)
        );
        expect(
          diff,
          `${tc.name} seed=${seed} after-seed: ${diff}`
        ).toBeUndefined();

        for (let txn = 0; txn < 150; txn++) {
          const ops: RowOp[] = [];
          for (let i = 0, n = 1 + rng.int(3); i < n; i++) {
            const roll = rng.next();
            if (roll < 0.35) {
              ops.push({
                table: "comments",
                kind: "insert",
                newRow: {
                  id: ++nextId,
                  user_id: 1 + rng.int(10),
                  room_id: 1 + rng.int(2),
                  score: rng.int(20)
                }
              });
            } else if (roll < 0.55) {
              const all = [...state.rows("comments")];
              const v = all[rng.int(Math.max(1, all.length))];
              if (v)
                ops.push({
                  table: "comments",
                  kind: "delete",
                  oldRow: { ...v }
                });
            } else if (roll < 0.75) {
              const live = [...state.rows("users")];
              const v = live[rng.int(Math.max(1, live.length))];
              if (v)
                ops.push({
                  table: "users",
                  kind: "update",
                  newRow: { id: v.id, name: names[rng.int(names.length)] },
                  oldRow: { ...v }
                });
            } else if (roll < 0.9) {
              const uid = 1 + rng.int(10);
              if (![...state.rows("users")].some(u => u.id === uid))
                ops.push({
                  table: "users",
                  kind: "insert",
                  newRow: { id: uid, name: names[rng.int(names.length)] }
                });
            } else {
              const all = [...state.rows("users")];
              const v = all[rng.int(Math.max(1, all.length))];
              if (v)
                ops.push({
                  table: "users",
                  kind: "delete",
                  oldRow: { ...v }
                });
            }
          }
          if (ops.length === 0) continue;
          state.ingest(ops);
          await applyTxn(lazy, commit(txn + 1, ops));

          diff = mapsEqual(
            viewToMap(lazy.materializer),
            recompute(query, tc.params, opts, state)
          );
          expect(
            diff,
            `${tc.name} seed=${seed} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    });
  }
});

describe("keyset page SQL", () => {
  const key = (
    column: string,
    o: Partial<WindowSortKey> = {}
  ): WindowSortKey => ({
    alias: "x",
    column,
    anchor: true,
    desc: false,
    nullsFirst: false,
    cls: "number",
    ...o
  });
  const order: WindowSortKey[] = [
    key("score", { desc: true, nullsFirst: true }),
    key("name", { cls: "text" }),
    key("id")
  ];

  it('renders ORDER BY with COLLATE "C" on text keys and a pk tiebreak', () => {
    expect(orderBySql(order)).toBe(
      '"x"."score" DESC NULLS FIRST, "x"."name" COLLATE "C" ASC NULLS LAST, ' +
        '"x"."id" ASC NULLS LAST'
    );
  });

  it("collates a text pk tiebreak (PG must byte-order it like JS)", () => {
    const textPk: WindowSortKey[] = [order[0]!, key("slug", { cls: "text" })];
    expect(orderBySql(textPk)).toBe(
      '"x"."score" DESC NULLS FIRST, "x"."slug" COLLATE "C" ASC NULLS LAST'
    );
    const params: unknown[] = [];
    const sql = keysetAfterSql(
      textPk,
      [5, "a-slug"],
      v => `$${params.push(v)}`
    );
    expect(sql).toContain('"x"."slug" COLLATE "C" > $');
  });

  const binder = () => {
    const params: unknown[] = [];
    return { params, bind: (v: unknown) => `$${params.push(v)}` };
  };

  it("renders the strictly-after cursor with NULL-aware branches, bound", () => {
    const { params, bind } = binder();
    const sql = keysetAfterSql(order, [5, "bob", 42], bind);
    expect(sql).toBe(
      '(("x"."score" < $1) OR ' +
        '("x"."score" = $2 AND ("x"."name" COLLATE "C" > $3 OR "x"."name" IS NULL)) OR ' +
        '("x"."score" = $2 AND "x"."name" = $4 AND ("x"."id" > $5 OR "x"."id" IS NULL)))'
    );
    expect(params).toEqual([5, 5, "bob", "bob", 42]);
  });

  it("a NULL bound on a NULLS FIRST key admits all non-null values", () => {
    const { params, bind } = binder();
    const sql = keysetAfterSql(order, [null, "bob", 42], bind);
    expect(sql).toBe(
      '(("x"."score" IS NOT NULL) OR ' +
        '("x"."score" IS NULL AND ("x"."name" COLLATE "C" > $1 OR "x"."name" IS NULL)) OR ' +
        '("x"."score" IS NULL AND "x"."name" = $2 AND ("x"."id" > $3 OR "x"."id" IS NULL)))'
    );
    expect(params).toEqual(["bob", "bob", 42]);
  });
});

const CR_PK = { comments: ["id"], replies: ["id"] };
const CR_TYPES = {
  comments: { id: "int4", user_id: "int4", room_id: "int4", body: "text" },
  replies: { id: "int4", comment_id: "int4", body: "text" }
};

describe("per-parent child window: a page per parent, sourced lazily", () => {
  const sql =
    "SELECT c.id AS id, (" +
    "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id ASC), '[]')" +
    "  FROM (SELECT r.id, r.body, r.comment_id FROM replies r WHERE r.comment_id = c.id ORDER BY r.id ASC LIMIT 3 OFFSET 2) r" +
    ") AS replies FROM comments c WHERE c.room_id = $1";
  const opts = {
    keyColumnsByTable: CR_PK,
    columnTypes: CR_TYPES
  };

  async function build() {
    const state = new StateStore();
    for (const [t, cols] of Object.entries(CR_PK)) state.setKeyColumns(t, cols);
    const initial: RowOp[] = [
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 1, user_id: 1, room_id: 1, body: "c1" }
      },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 2, user_id: 1, room_id: 1, body: "c2" }
      }
    ];
    for (let i = 10; i <= 49; i++)
      initial.push({
        table: "replies",
        kind: "insert",
        newRow: { id: i, comment_id: 1, body: `r${i}` }
      });
    for (let i = 110; i <= 149; i++)
      initial.push({
        table: "replies",
        kind: "insert",
        newRow: { id: i, comment_id: 2, body: `r${i}` }
      });
    state.ingest(initial);
    const { query, shape } = await compileShape(sql, [1], opts);
    const counting = new CountingSource(new MemRowSource(t => state.rows(t)));
    const lazy = new LazyTree(shape, [1], counting.source);
    await seedTree(lazy);
    return { state, query, lazy, counting };
  }

  const pages = (lazy: LazyTree): Map<unknown, unknown[]> => {
    const m = new Map<unknown, unknown[]>();
    for (const c of lazy.materializer.snapshot() as Array<Row>)
      m.set(
        c.id,
        ((c.replies as Array<Row>) ?? []).map(r => r.id)
      );
    return m;
  };
  const exact = (lazy: LazyTree, query: ShapeQuery, state: StateStore): void =>
    exactAgainstRecompute(lazy, query, state, [1], opts);

  it("seeds one page per parent and holds only the pages resident", async () => {
    const { lazy } = await build();
    const p = pages(lazy);
    expect(p.get(1)).toEqual([12, 13, 14]);
    expect(p.get(2)).toEqual([112, 113, 114]);
    expect(lazy.workingSetSize).toBeLessThan(2 + 80);
    expect(lazy.workingSetSize).toBeLessThanOrEqual(2 + 2 * 21);
  });

  it("insert before one parent's offset shifts only that parent's page", async () => {
    const { state, query, lazy } = await build();
    const ops: RowOp[] = [
      {
        table: "replies",
        kind: "insert",
        newRow: { id: 5, comment_id: 1, body: "r5" }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    const p = pages(lazy);
    expect(p.get(1)).toEqual([11, 12, 13]);
    expect(p.get(2)).toEqual([112, 113, 114]);
    exact(lazy, query, state);
  });

  it("deleting most of one parent's resident page triggers a per-parent refill", async () => {
    const { state, query, lazy, counting } = await build();
    const before = counting.pagedReads;
    const ops: RowOp[] = [];
    for (let i = 10; i <= 28; i++)
      ops.push({ table: "replies", kind: "delete", oldRow: { id: i } });
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    const p = pages(lazy);
    expect(p.get(1)).toEqual([31, 32, 33]);
    expect(p.get(2)).toEqual([112, 113, 114]);
    exact(lazy, query, state);
    expect(counting.pagedReads).toBeGreaterThan(before);
    expect(lazy.workingSetSize).toBeLessThan(2 + 80);
  });

  it("incremental == recompute over a random per-parent workload", async () => {
    const rng = new Rng(7);
    const { state, query, lazy } = await build();
    let nextId = 1000;
    for (let txn = 0; txn < 150; txn++) {
      const ops: RowOp[] = [];
      for (let i = 0, n = 1 + rng.int(3); i < n; i++) {
        const cid = 1 + rng.int(2);
        const roll = rng.next();
        const live = [...state.rows("replies")].filter(
          r => r.comment_id === cid
        );
        if (roll < 0.5 || live.length === 0) {
          ops.push({
            table: "replies",
            kind: "insert",
            newRow: { id: ++nextId, comment_id: cid, body: `n${nextId}` }
          });
          if (rng.next() < 0.4)
            ops.push({
              table: "replies",
              kind: "insert",
              newRow: { id: rng.int(160), comment_id: cid, body: "small" }
            });
        } else if (roll < 0.8) {
          const v = live[rng.int(live.length)]!;
          ops.push({ table: "replies", kind: "delete", oldRow: { id: v.id } });
        } else {
          const v = live[rng.int(live.length)]!;
          ops.push({
            table: "replies",
            kind: "update",
            newRow: { id: v.id, comment_id: cid, body: `u${rng.int(9)}` },
            oldRow: { id: v.id }
          });
        }
      }
      state.ingest(ops);
      await applyTxn(lazy, commit(txn + 1, ops));
      exact(lazy, query, state);
    }
  });
});

describe("per-parent child window over a composite correlation", () => {
  const sql =
    "SELECT c.id AS id, c.org_id AS org_id, c.room_id AS room_id, (" +
    "  SELECT coalesce(json_agg(json_build_object('id', p.id, 'label', p.label) ORDER BY p.id ASC), '[]')" +
    "  FROM (SELECT p.id, p.label, p.org_id, p.room_id FROM pins p" +
    "        WHERE p.org_id = c.org_id AND p.room_id = c.room_id" +
    "        ORDER BY p.id ASC LIMIT 3) p" +
    ") AS pins FROM comments c";
  const PIN_PK = { comments: ["id"], pins: ["id"] };
  const PIN_TYPES = {
    comments: { id: "int4", org_id: "int4", room_id: "int4", body: "text" },
    pins: { id: "int4", org_id: "int4", room_id: "int4", label: "text" }
  };
  const opts = {
    keyColumnsByTable: PIN_PK,
    columnTypes: PIN_TYPES
  };

  async function build() {
    const state = new StateStore();
    for (const [t, cols] of Object.entries(PIN_PK))
      state.setKeyColumns(t, cols);
    const initial: RowOp[] = [
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 1, org_id: 1, room_id: 1, body: "a" }
      },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 2, org_id: 1, room_id: 2, body: "b" }
      }
    ];
    for (let i = 10; i <= 49; i++)
      initial.push({
        table: "pins",
        kind: "insert",
        newRow: { id: i, org_id: 1, room_id: 1, label: `p${i}` }
      });
    for (let i = 110; i <= 149; i++)
      initial.push({
        table: "pins",
        kind: "insert",
        newRow: { id: i, org_id: 1, room_id: 2, label: `p${i}` }
      });
    state.ingest(initial);
    const { query, shape } = await compileShape(sql, [], opts);
    const lazy = new LazyTree(shape, [], new MemRowSource(t => state.rows(t)));
    await seedTree(lazy);
    return { state, query, shape, lazy };
  }

  const exact = (lazy: LazyTree, query: ShapeQuery, state: StateStore): void =>
    exactAgainstRecompute(lazy, query, state, [], opts);

  it("plans the window and holds only a page per parent tuple", async () => {
    const { state, query, shape, lazy } = await build();
    expect(shape.root.collections[0]!.level.window).toBeDefined();
    const rows = lazy.materializer.snapshot() as Array<Row>;
    expect(
      rows.map(r => [r.id, ((r.pins as Array<Row>) ?? []).map(p => p.id)])
    ).toEqual([
      [1, [10, 11, 12]],
      [2, [110, 111, 112]]
    ]);
    const page = 3 + 16; // pageSizeFor(3)
    expect(lazy.workingSetSize).toBeLessThanOrEqual(2 + 2 * page);
    exact(lazy, query, state);
  });

  it("incremental == recompute under churn on both key halves", async () => {
    const rng = new Rng(21);
    const { state, query, lazy } = await build();
    let nextId = 1000;
    for (let txn = 0; txn < 100; txn++) {
      const ops: RowOp[] = [];
      for (let i = 0, n = 1 + rng.int(3); i < n; i++) {
        const org = 1;
        const room = 1 + rng.int(2);
        const roll = rng.next();
        const live = [...state.rows("pins")].filter(
          r => r.org_id === org && r.room_id === room
        );
        if (roll < 0.5 || live.length === 0) {
          ops.push({
            table: "pins",
            kind: "insert",
            newRow: {
              id: rng.next() < 0.3 ? rng.int(160) : ++nextId,
              org_id: org,
              room_id: room,
              label: "n"
            }
          });
        } else if (roll < 0.8) {
          const v = live[rng.int(live.length)]!;
          ops.push({ table: "pins", kind: "delete", oldRow: { id: v.id } });
        } else {
          const v = live[rng.int(live.length)]!;
          ops.push({
            table: "pins",
            kind: "update",
            newRow: { id: v.id, org_id: org, room_id: 3 - room, label: "m" },
            oldRow: { id: v.id }
          });
        }
      }
      state.ingest(ops);
      await applyTxn(lazy, commit(txn + 1, ops));
      exact(lazy, query, state);
    }
  });
});
