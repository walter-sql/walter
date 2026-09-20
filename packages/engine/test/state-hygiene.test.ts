import { describe, it, expect } from "vitest";
import {
  compileShape,
  allLevels,
  viewToMap,
  mapsEqual,
  recompute,
  Rng
} from "./support";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import { LazyTree } from "../src/lazy/lazy-tree";
import { planShape, type ShapeTreePlan } from "../src/planner/plan";
import type { DataflowNode } from "../src/ivm/node";
import { applyTxn, catalogOf, commit, seedTree, type RowOp } from "./support";
import type { Row } from "../src/ivm/zset";
import type { ShapeQuery } from "../src/parser/ir";

const PK = { users: ["id"], comments: ["id"], replies: ["id"] };

interface Tpl {
  name: string;
  sql: string;
  params: unknown[];
  tables: (keyof typeof PK)[];
}

const TEMPLATES: Tpl[] = [
  {
    name: "unwindowed join",
    sql: "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1",
    params: [1],
    tables: ["users", "comments"]
  },
  {
    name: "windowed root over the joined output",
    sql: "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1 ORDER BY u.name ASC, c.id ASC LIMIT 4",
    params: [1],
    tables: ["users", "comments"]
  },
  {
    name: "LEFT JOIN + json_agg aggregate",
    sql:
      "SELECT c.id AS id, c.body AS body, " +
      "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
      "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id WHERE c.room_id = $1 GROUP BY c.id",
    params: [1],
    tables: ["comments", "replies"]
  },
  {
    name: "EXISTS",
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
    name: "DISTINCT",
    sql: "SELECT DISTINCT c.body AS body FROM comments c WHERE c.room_id = $1",
    params: [1],
    tables: ["comments"]
  }
];

class Model {
  private readonly rows = new Map<string, Map<number, Row>>();
  private seq = 0;

  constructor(private readonly rng: Rng) {}

  private make(table: string, id: number): Row {
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
      default:
        return {
          id,
          comment_id: 1 + this.rng.int(10),
          body: this.rng.pick(["a", "b", "c"])
        };
    }
  }

  private tableRows(table: string): Map<number, Row> {
    let m = this.rows.get(table);
    if (!m) this.rows.set(table, (m = new Map()));
    return m;
  }

  insert(table: string): RowOp {
    const id = ++this.seq;
    const newRow = this.make(table, id);
    this.tableRows(table).set(id, newRow);
    return { table, kind: "insert", newRow };
  }

  randomOp(table: string): RowOp {
    const rows = this.tableRows(table);
    const ids = [...rows.keys()];
    const roll = this.rng.next();
    if (roll < 0.5 || ids.length === 0) return this.insert(table);
    const id = ids[this.rng.int(ids.length)]!;
    const oldRow = { ...rows.get(id)! };
    if (roll < 0.82) {
      const newRow = this.make(table, id);
      rows.set(id, newRow);
      return { table, kind: "update", newRow, oldRow };
    }
    rows.delete(id);
    return { table, kind: "delete", oldRow };
  }

  deleteAll(): RowOp[] {
    const ops: RowOp[] = [];
    for (const [table, rows] of this.rows) {
      for (const row of rows.values())
        ops.push({ table, kind: "delete", oldRow: { ...row } });
      rows.clear();
    }
    return ops;
  }
}

function nodesOf(root: DataflowNode): DataflowNode[] {
  const seen = new Set<DataflowNode>();
  const walk = (n: DataflowNode): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const inp of n.inputs) walk(inp);
  };
  walk(root);
  return [...seen];
}

async function runCase(
  name: string,
  query: ShapeQuery,
  params: unknown[],
  shape: ShapeTreePlan,
  tables: string[],
  seed: number
): Promise<void> {
  const rng = new Rng(seed);
  const model = new Model(rng);
  const state = new StateStore();
  for (const [t, cols] of Object.entries(PK)) {
    state.setKeyColumns(t, cols);
  }

  const initial: RowOp[] = [];
  for (let i = 0; i < 10; i++) {
    for (const t of tables) initial.push(model.insert(t));
  }
  state.ingest(initial);

  const opts = { keyColumnsByTable: PK };
  const lazy = new LazyTree(
    shape,
    params,
    new MemRowSource(t => state.rows(t))
  );
  await seedTree(lazy);

  let xid = 0;
  for (let txn = 0; txn < 80; txn++) {
    const ops: RowOp[] = [];
    for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
      ops.push(model.randomOp(rng.pick(tables)));
    }
    state.ingest(ops);
    await applyTxn(lazy, commit(++xid, ops));
  }
  const diff = mapsEqual(
    viewToMap(lazy.materializer),
    recompute(query, params, opts, state)
  );
  expect(diff, `${name} seed=${seed} pre-wipe: ${diff}`).toBeUndefined();

  const wipe = model.deleteAll();
  state.ingest(wipe);
  await applyTxn(lazy, commit(++xid, wipe));

  expect(viewToMap(lazy.materializer).size).toBe(0);
  expect(lazy.workingSetSize).toBe(0);
  expect(lazy.edgeRefSize).toBe(shape.root.window ? 1 : 0);
  expect(lazy.materializer.stateSize).toBe(0);
  for (const level of allLevels(shape)) {
    for (const node of nodesOf(level.dataflow.root)) {
      expect(
        node.stateSize,
        `${name} seed=${seed}: ${node.constructor.name} retains state`
      ).toBe(0);
    }
  }
}

describe("state hygiene: empty database ⇒ empty engine", () => {
  for (const tpl of TEMPLATES) {
    it(tpl.name, async () => {
      const opts = { keyColumnsByTable: PK };
      const { query, shape } = await compileShape(tpl.sql, tpl.params, opts);
      for (const seed of [5, 23]) {
        await runCase(tpl.name, query, tpl.params, shape, tpl.tables, seed);
      }
    });
  }

  const child = (limit: number | undefined): ShapeQuery => ({
    query: {
      from: { kind: "table", name: "replies", alias: "r" },
      select: [
        { expr: { kind: "column", name: "id", table: "r" }, alias: "id" },
        { expr: { kind: "column", name: "body", table: "r" }, alias: "body" },
        {
          expr: { kind: "column", name: "comment_id", table: "r" },
          alias: "comment_id"
        }
      ],
      where: undefined,
      groupBy: [],
      having: undefined,
      distinct: false,
      orderBy: limit
        ? [
            {
              expr: { kind: "column", name: "id", table: "r" },
              desc: true,
              nullsFirst: false
            }
          ]
        : [],
      limit
    },
    collections: []
  });
  const tree = (limit: number | undefined): ShapeQuery => ({
    query: {
      from: { kind: "table", name: "comments", alias: "c" },
      select: [
        { expr: { kind: "column", name: "id", table: "c" }, alias: "id" },
        { expr: { kind: "column", name: "body", table: "c" }, alias: "body" }
      ],
      where: undefined,
      groupBy: [],
      having: undefined,
      distinct: false,
      orderBy: []
    },
    collections: [
      {
        field: "replies",
        parentKey: ["id"],
        childKey: ["comment_id"],
        object: false,
        node: child(limit)
      }
    ]
  });

  for (const [name, limit] of [
    ["unwindowed child collection", undefined],
    ["windowed child (per-parent ORDER BY + LIMIT)", 2]
  ] as const) {
    it(name, async () => {
      const query = tree(limit);
      const shape = planShape(
        query,
        [],
        catalogOf({
          keyColumnsByTable: PK,
          columnTypes: {
            comments: { id: "int4", body: "text" },
            replies: { id: "int4", comment_id: "int4", body: "text" }
          }
        })
      );
      for (const seed of [5, 23]) {
        await runCase(name, query, [], shape, ["comments", "replies"], seed);
      }
    });
  }
});
