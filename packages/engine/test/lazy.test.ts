import { describe, it, expect } from "vitest";
import {
  catalogOf,
  compileShape,
  recompute,
  viewToMap,
  mapsEqual,
  Rng
} from "./support";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import { BatchingRowSource } from "../src/lazy/batching-source";
import { absorbedThrough } from "../src/lazy/snapshot";
import { LazyTree } from "../src/lazy/lazy-tree";
import { exprToSql } from "../src/lazy/pg-source";
import { parseSql } from "../src/parser/parse";
import { expandStars } from "../src/parser/expand";
import { foldArrayParams } from "../src/planner/plan";
import { PlanScope } from "../src/planner/scope";
import { threadQueryTypes } from "../src/planner/types";
import { applyTxn, commit, seedTree, type RowOp } from "./support";
import { stableStringify, type Row } from "../src/ivm/zset";

const PK = { item: ["id"] };

interface Tpl {
  name: string;
  sql: string;
  params: unknown[];
}

const TEMPLATES: Tpl[] = [
  {
    name: "filter + project",
    sql: "SELECT id, room, score FROM item WHERE room = $1",
    params: ["r1"]
  },
  {
    name: "compound filter",
    sql: "SELECT id, score FROM item WHERE room = $1 AND score >= $2",
    params: ["r1", 3]
  },
  {
    name: "unfiltered",
    sql: "SELECT id, room FROM item",
    params: []
  },
  {
    name: "order by + limit",
    sql: "SELECT id, score FROM item WHERE room = $1 ORDER BY score DESC, id ASC LIMIT 3",
    params: ["r1"]
  },
  {
    name: "group by aggregates",
    sql: "SELECT room AS room, count(*) AS n, sum(score) AS total, min(score) AS lo, max(score) AS hi FROM item WHERE score >= $1 GROUP BY room",
    params: [0]
  },
  {
    name: "distinct rooms",
    sql: "SELECT DISTINCT room AS room FROM item WHERE score >= $1",
    params: [2]
  }
];

class Model {
  readonly ids: number[] = [];
  private seq = 0;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  fields(): Row {
    return {
      room: this.rng.pick(["r1", "r2", "r3"]),
      score: this.rng.int(10),
      body: this.rng.pick(["x", "y", "z"])
    };
  }

  insert(): RowOp {
    const id = ++this.seq;
    this.ids.push(id);
    return { table: "item", kind: "insert", newRow: { id, ...this.fields() } };
  }

  existing(): number | undefined {
    if (this.ids.length === 0) return undefined;
    return this.ids[this.rng.int(this.ids.length)];
  }

  randomOp(rng: Rng): RowOp | undefined {
    const roll = rng.next();
    const id = this.existing();
    if (roll < 0.5 || id === undefined) return this.insert();
    if (roll < 0.82) {
      return {
        table: "item",
        kind: "update",
        newRow: { id, ...this.fields() },
        oldRow: { id }
      };
    }
    const i = this.ids.indexOf(id);
    if (i >= 0) this.ids.splice(i, 1);
    return { table: "item", kind: "delete", oldRow: { id } };
  }
}

describe("lazy single-table: scoped incremental == full recompute", () => {
  for (const tpl of TEMPLATES) {
    it(tpl.name, async () => {
      for (const seed of [1, 7, 1337]) {
        const rng = new Rng(seed);
        const model = new Model(rng);
        const state = new StateStore();
        state.setKeyColumns("item", PK.item);

        const initial: RowOp[] = [];
        const n0 = 5 + rng.int(12);
        for (let i = 0; i < n0; i++) initial.push(model.insert());
        state.ingest(initial);

        const opts = { keyColumnsByTable: PK };
        const { query, shape } = await compileShape(tpl.sql, tpl.params, opts);
        const source = new MemRowSource(t => state.rows(t));
        const lazy = new LazyTree(shape, tpl.params, source);
        await seedTree(lazy);

        let diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(query, tpl.params, opts, state)
        );
        expect(
          diff,
          `${tpl.name} seed=${seed} after-seed: ${diff}`
        ).toBeUndefined();

        for (let txn = 0; txn < 200; txn++) {
          const opCount = 1 + rng.int(4);
          const ops: RowOp[] = [];
          for (let i = 0; i < opCount; i++) {
            const op = model.randomOp(rng);
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

const JOIN_PK = {
  users: ["id"],
  comments: ["id"],
  replies: ["id"],
  events: ["id"],
  totals: ["id"]
};

interface JoinTpl {
  name: string;
  sql: string;
  params: unknown[];
  tables: (keyof typeof JOIN_PK)[];
}

const JOIN_TEMPLATES: JoinTpl[] = [
  {
    name: "inner join (users dim)",
    sql: "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1",
    params: [1],
    tables: ["users", "comments"]
  },
  {
    name: "left join nesting (replies dim)",
    sql:
      "SELECT c.id AS id, c.body AS body, " +
      "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
      "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id WHERE c.room_id = $1 GROUP BY c.id",
    params: [1],
    tables: ["comments", "replies"]
  },
  {
    name: "two anchors (both filtered)",
    sql: "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1 AND u.name = $2",
    params: [1, "Ann"],
    tables: ["users", "comments"]
  },
  {
    name: "composite equi-join (tuple pull edge)",
    sql: "SELECT e.id AS id, e.kind AS kind, t.n AS n FROM events e JOIN totals t ON t.room_id = e.room_id AND t.day = e.day WHERE e.kind = $1",
    params: ["x"],
    tables: ["events", "totals"]
  },
  {
    name: "EXISTS (child gates parent)",
    sql: "SELECT c.id AS id, c.body AS body FROM comments c WHERE c.room_id = $1 AND EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id)",
    params: [1],
    tables: ["comments", "replies"]
  },
  {
    name: "NOT EXISTS with child-local filter",
    sql: "SELECT c.id AS id, c.body AS body FROM comments c WHERE c.room_id = $1 AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id AND r.body = $2)",
    params: [1, "a"],
    tables: ["comments", "replies"]
  },
  {
    name: "IN (subquery) via the EXISTS desugar",
    sql: "SELECT c.id AS id, c.body AS body FROM comments c WHERE c.room_id = $1 AND c.user_id IN (SELECT u.id FROM users u WHERE u.name = $2)",
    params: [1, "Ann"],
    tables: ["users", "comments"]
  }
];

class JoinModel {
  private readonly ids = new Map<string, number[]>();
  private seq = 0;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  private make(table: string): Row {
    const id = ++this.seq;
    switch (table) {
      case "users":
        return { id, name: this.rng.pick(["Ann", "Bob", "Cy", "Dee"]) };
      case "comments":
        return {
          id,
          user_id: 1 + this.rng.int(6),
          room_id: 1 + this.rng.int(3),
          body: this.rng.pick(["x", "y", "z"])
        };
      case "replies":
        return {
          id,
          comment_id: 1 + this.rng.int(10),
          body: this.rng.pick(["a", "b", "c"])
        };
      case "events":
        return {
          id,
          room_id: 1 + this.rng.int(3),
          day: 1 + this.rng.int(3),
          kind: this.rng.pick(["x", "y", "z"])
        };
      case "totals":
        return {
          id,
          room_id: 1 + this.rng.int(3),
          day: 1 + this.rng.int(3),
          n: this.rng.int(10)
        };
      default:
        return { id };
    }
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
    if (roll < 0.5 || id === undefined) {
      const newRow = this.make(table);
      this.track(table, newRow.id as number);
      return { table, kind: "insert", newRow };
    }
    if (roll < 0.82) {
      const newRow = { ...this.make(table), id };
      return { table, kind: "update", newRow, oldRow: { id } };
    }
    this.forget(table, id);
    return { table, kind: "delete", oldRow: { id } };
  }
}

describe("PgRowSource predicate serializer (IR -> SQL)", () => {
  const ITEM_TYPES = {
    item: {
      id: "int4",
      room: "text",
      score: "int4",
      status: "text",
      deleted_at: "timestamptz",
      name: "text"
    }
  };
  const ITEM_CATALOG = catalogOf({ columnTypes: ITEM_TYPES });
  const resolve = new PlanScope([{ name: "item", alias: "item" }], ITEM_CATALOG)
    .classOf;
  const PARAMS = ["a", 42];
  const cases: [string, string, unknown[]][] = [
    ["SELECT id FROM item WHERE room = $1", '("room" = $1)', ["a"]],
    [
      "SELECT id FROM item WHERE room = $1 AND score >= $2",
      '(("room" = $1) AND ("score" >= $2))',
      ["a", 42]
    ],
    [
      "SELECT id FROM item WHERE status IN ($1, $2)",
      '("status" IN ($1, $2))',
      ["a", 42]
    ],
    [
      "SELECT id FROM item WHERE deleted_at IS NULL",
      '("deleted_at" IS NULL)',
      []
    ],
    [
      "SELECT id FROM item WHERE name ILIKE $1",
      '("name" COLLATE "C" ILIKE $1)',
      ["a"]
    ],
    ["SELECT id FROM item WHERE score >= $2", '("score" >= $1)', [42]]
  ];
  for (const [sql, expected, bound] of cases) {
    it(sql, async () => {
      const query = await parseSql(sql);
      expect(query.where).toBeDefined();
      expandStars(query, ITEM_CATALOG);
      threadQueryTypes(query, resolve);
      const values: unknown[] = [];
      const bind = (v: unknown) => `$${values.push(v)}`;
      expect(exprToSql(query.where!, PARAMS, bind)).toBe(expected);
      expect(values).toEqual(bound);
    });
  }

  const foldedCases: [string, unknown[], string][] = [
    ["score = ANY ($1)", [[1, 2]], `("score" IN ('1', '2'))`],
    ["score = ANY ($1)", [[]], "FALSE"],
    ["score <> ALL ($1)", [[]], "TRUE"],
    ["score = ANY ($1)", [null], '("score" IN (NULL))']
  ];
  for (const [where, params, expected] of foldedCases) {
    it(`${where} with ${JSON.stringify(params)}`, async () => {
      const query = await parseSql(`SELECT id FROM item WHERE ${where}`);
      foldArrayParams({ query, collections: [] }, params);
      expandStars(query, ITEM_CATALOG);
      threadQueryTypes(query, resolve);
      const values: unknown[] = [];
      const bind = (v: unknown) => `$${values.push(v)}`;
      expect(exprToSql(query.where!, params, bind)).toBe(expected);
      expect(values).toEqual([]);
    });
  }
});

describe("lazy LSN high-water-mark: stale WAL is absorbed by the snapshot", () => {
  it("ignores WAL changes already reflected in a fetched/seeded row", async () => {
    const state = new StateStore();
    for (const [t, cols] of Object.entries(JOIN_PK))
      state.setKeyColumns(t, cols);
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 10, name: "A" } },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 1, user_id: 10, room_id: 1, body: "x" }
      }
    ]);

    const head = { snap: absorbedThrough(20) };
    const sql =
      "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1";
    const opts = { keyColumnsByTable: JOIN_PK };
    const { shape } = await compileShape(sql, [1], opts);
    const source = new MemRowSource(
      t => state.rows(t),
      () => head.snap
    );
    const lazy = new LazyTree(shape, [1], source);
    await seedTree(lazy);
    const rows = () => [...viewToMap(lazy.materializer).values()];
    expect(rows()).toEqual([stableStringify({ id: 1, name: "A" })]);

    const stale = await applyTxn(
      lazy,
      commit(10, [
        {
          table: "users",
          kind: "update",
          newRow: { id: 10, name: "STALE" },
          oldRow: { id: 10 }
        }
      ])
    );
    expect(stale).toEqual([]);
    expect(rows()).toEqual([stableStringify({ id: 1, name: "A" })]);

    const fresh = await applyTxn(
      lazy,
      commit(30, [
        {
          table: "users",
          kind: "update",
          newRow: { id: 10, name: "B" },
          oldRow: { id: 10 }
        }
      ])
    );
    expect(fresh.length).toBe(1);
    expect(rows()).toEqual([stableStringify({ id: 1, name: "B" })]);
  });
});

describe("lazy sourcing analysis: pull edges from the planner's join keys", () => {
  it("a null-tolerant predicate never bounds a LEFT JOIN's nullable side", async () => {
    const opts = { keyColumnsByTable: JOIN_PK };
    const state = new StateStore();
    state.setKeyColumns("users", JOIN_PK.users);
    state.setKeyColumns("comments", JOIN_PK.comments);
    state.ingest([
      { table: "users", kind: "insert", newRow: { id: 1, name: "one" } },
      { table: "users", kind: "insert", newRow: { id: 2, name: "two" } },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 10, user_id: 1, room_id: 1, body: "b", score: 0 }
      }
    ]);
    for (const where of [
      "c.body IS NULL",
      "coalesce(c.score, 0) = 0",
      "c.body IS NULL OR c.body = 'b'"
    ]) {
      const sql = `SELECT u.id AS id, c.body AS body FROM users u LEFT JOIN comments c ON c.user_id = u.id WHERE ${where}`;
      const { query, shape } = await compileShape(sql, [], opts);
      expect(
        shape.root.lazySourcing().byTable.get("comments")!.localPred
      ).toBeUndefined();
      const lazy = new LazyTree(
        shape,
        [],
        new MemRowSource(t => state.rows(t))
      );
      await seedTree(lazy);
      const diff = mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, [], opts, state)
      );
      expect(diff, where).toBeUndefined();
    }
    const { shape } = await compileShape(
      "SELECT u.id AS id, c.body AS body FROM users u LEFT JOIN comments c ON c.user_id = u.id WHERE c.score > 0",
      [],
      opts
    );
    expect(
      shape.root.lazySourcing().byTable.get("comments")!.localPred
    ).toBeDefined();
  });

  it("composite equi-join yields one tuple-valued edge", async () => {
    const { shape } = await compileShape(
      "SELECT e.id AS id, t.n AS n FROM events e JOIN totals t ON t.room_id = e.room_id AND t.day = e.day WHERE e.kind = $1",
      ["x"],
      { keyColumnsByTable: JOIN_PK }
    );
    const sourcing = shape.root.lazySourcing();
    expect(sourcing.edges).toEqual([
      {
        puller: { table: "events", cols: ["room_id", "day"] },
        dimTable: "totals",
        dimCols: ["room_id", "day"],
        classes: ["number", "number"]
      }
    ]);
    expect(sourcing.byTable.get("totals")!.isDim).toBe(true);
  });

  it("EXISTS contributes a pull edge and sources the child as a dim", async () => {
    const { shape } = await compileShape(
      "SELECT c.id AS id FROM comments c WHERE c.room_id = $1 AND EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id)",
      [1],
      { keyColumnsByTable: JOIN_PK }
    );
    const sourcing = shape.root.lazySourcing();
    expect(sourcing.edges).toEqual([
      {
        puller: { table: "comments", cols: ["id"] },
        dimTable: "replies",
        dimCols: ["comment_id"],
        classes: ["number"]
      }
    ]);
    expect(sourcing.byTable.get("replies")!.isDim).toBe(true);
  });

  it("IN (subquery) matches PG NULL semantics: NULL never matches", async () => {
    const pk = { item: ["id"], comments: ["id"] };
    const state = new StateStore();
    for (const [t, cols] of Object.entries(pk)) state.setKeyColumns(t, cols);
    state.ingest([
      { table: "item", kind: "insert", newRow: { id: 1, score: 1 } },
      { table: "item", kind: "insert", newRow: { id: 2, score: 2 } },
      { table: "item", kind: "insert", newRow: { id: 3, score: null } },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 10, user_id: 1, room_id: 1, body: "x", score: 1 }
      },
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 11, user_id: 1, room_id: 1, body: "y", score: null }
      }
    ]);
    const { shape } = await compileShape(
      "SELECT i.id AS id FROM item i WHERE i.score IN (SELECT c.score FROM comments c)",
      [],
      { keyColumnsByTable: pk }
    );
    const lazy = new LazyTree(shape, [], new MemRowSource(t => state.rows(t)));
    await seedTree(lazy);
    const rows = () => [...viewToMap(lazy.materializer).values()].sort();
    const expected = (...ns: number[]) =>
      ns.map(id => stableStringify({ id })).sort();
    expect(rows()).toEqual(expected(1));

    const ops: RowOp[] = [
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 12, user_id: 1, room_id: 1, body: "z", score: 2 }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(2, ops));
    expect(rows()).toEqual(expected(1, 2));
  });

  it("pull edges and collection keys match int8 text to int4 numbers", async () => {
    const types = {
      big: { id: "int8", grp: "int4" },
      small: { id: "int4", big_id: "int4" }
    };
    const pk = { big: ["id"], small: ["id"] };
    const state = new StateStore();
    for (const [t, cols] of Object.entries(pk)) state.setKeyColumns(t, cols);
    state.ingest([
      { table: "big", kind: "insert", newRow: { id: "5", grp: 1 } },
      { table: "small", kind: "insert", newRow: { id: 1, big_id: 5 } }
    ]);
    const spec = { columnTypes: types, keyColumnsByTable: pk };
    const catalog = catalogOf(spec);
    const source = new BatchingRowSource(
      new MemRowSource(t => state.rows(t), undefined, catalog),
      catalog
    );
    const rows = async (sql: string) => {
      const { shape } = await compileShape(sql, [1], spec);
      const lazy = new LazyTree(shape, [1], source);
      await seedTree(lazy);
      return [...viewToMap(lazy.materializer).values()];
    };
    expect(
      await rows(
        "SELECT b.id AS id, s.id AS sid FROM big b JOIN small s ON s.big_id = b.id WHERE b.grp = $1"
      )
    ).toEqual([stableStringify({ id: "5", sid: 1 })]);
    expect(
      await rows(
        "SELECT b.id AS id, (SELECT json_agg(json_build_object('id', s.id)) FROM small s WHERE s.big_id = b.id) AS items FROM big b WHERE b.grp = $1"
      )
    ).toEqual([stableStringify({ id: "5", items: [{ id: 1 }] })]);
  });

  it("equi-less join still rejects (never a silent whole-table source)", async () => {
    const { shape } = await compileShape(
      "SELECT e.id AS id, t.n AS n FROM events e JOIN totals t ON t.day > e.day WHERE e.kind = $1",
      ["x"],
      { keyColumnsByTable: JOIN_PK }
    );
    expect(() => shape.root.lazySourcing()).toThrow(/equi-join condition/);
  });
});

describe("lazy joins: closure-sourced incremental == full recompute", () => {
  for (const tpl of JOIN_TEMPLATES) {
    it(tpl.name, async () => {
      for (const seed of [3, 11, 4242]) {
        const rng = new Rng(seed);
        const model = new JoinModel(rng);
        const state = new StateStore();
        for (const [t, cols] of Object.entries(JOIN_PK)) {
          state.setKeyColumns(t, cols);
        }

        const initial: RowOp[] = [];
        for (let i = 0; i < 12; i++) {
          for (const t of tpl.tables) {
            const op = model.randomOp(t);
            if (op?.kind === "insert") initial.push(op);
          }
        }
        state.ingest(initial);

        const opts = { keyColumnsByTable: JOIN_PK };
        const { query, shape } = await compileShape(tpl.sql, tpl.params, opts);
        const source = new MemRowSource(t => state.rows(t));
        const lazy = new LazyTree(shape, tpl.params, source);
        await seedTree(lazy);

        let diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(query, tpl.params, opts, state)
        );
        expect(
          diff,
          `${tpl.name} seed=${seed} after-seed: ${diff}`
        ).toBeUndefined();

        for (let txn = 0; txn < 220; txn++) {
          const opCount = 1 + rng.int(4);
          const ops: RowOp[] = [];
          for (let i = 0; i < opCount; i++) {
            const op = model.randomOp(rng.pick(tpl.tables));
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

describe("dim GC: the working set tracks the query", () => {
  const SQL =
    "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1";
  const opts = { keyColumnsByTable: JOIN_PK };

  const user = (id: number): Row => ({ id, name: `u${id}` });
  const comment = (id: number, userId: number): Row => ({
    id,
    user_id: userId,
    room_id: 1,
    body: "x"
  });

  async function setup() {
    const state = new StateStore();
    for (const [t, cols] of Object.entries(JOIN_PK)) {
      state.setKeyColumns(t, cols);
    }
    const initial: RowOp[] = [];
    for (const id of [1, 2]) {
      initial.push({ table: "users", kind: "insert", newRow: user(id) });
      initial.push({
        table: "comments",
        kind: "insert",
        newRow: comment(id, id)
      });
    }
    state.ingest(initial);
    const { query, shape } = await compileShape(SQL, [1], opts);
    const lazy = new LazyTree(shape, [1], new MemRowSource(t => state.rows(t)));
    await seedTree(lazy);
    const check = () =>
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(query, [1], opts, state)
      );
    expect(check()).toBeUndefined();
    return { state, lazy, check };
  }

  it("dropped anchors release the dims they pulled", async () => {
    const { state, lazy, check } = await setup();
    expect(lazy.workingSetSize).toBe(4);

    const grow: RowOp[] = [];
    for (let id = 10; id < 20; id++) {
      grow.push({ table: "users", kind: "insert", newRow: user(id) });
      grow.push({ table: "comments", kind: "insert", newRow: comment(id, id) });
    }
    state.ingest(grow);
    await applyTxn(lazy, commit(2, grow));
    expect(check()).toBeUndefined();
    expect(lazy.workingSetSize).toBe(24);

    const shrink: RowOp[] = [];
    for (let id = 10; id < 20; id++) {
      shrink.push({
        table: "comments",
        kind: "delete",
        oldRow: comment(id, id)
      });
    }
    state.ingest(shrink);
    await applyTxn(lazy, commit(3, shrink));
    expect(check()).toBeUndefined();
    expect(lazy.workingSetSize).toBe(4);
  });

  it("holds the working set flat over 10k insert/delete cycles", async () => {
    const { state, lazy, check } = await setup();
    const baseline = lazy.workingSetSize;
    const baseRefs = lazy.edgeRefSize;

    for (let i = 0; i < 10_000; i++) {
      const id = 100 + i;
      const ins: RowOp[] = [
        { table: "users", kind: "insert", newRow: user(id) },
        { table: "comments", kind: "insert", newRow: comment(id, id) }
      ];
      state.ingest(ins);
      await applyTxn(lazy, commit(2 * i + 2, ins));

      const del: RowOp[] = [
        { table: "comments", kind: "delete", oldRow: comment(id, id) },
        { table: "users", kind: "delete", oldRow: user(id) }
      ];
      state.ingest(del);
      await applyTxn(lazy, commit(2 * i + 3, del));

      expect(lazy.workingSetSize).toBe(baseline);
      expect(lazy.edgeRefSize).toBe(baseRefs);
    }
    expect(check()).toBeUndefined();
  });
});
