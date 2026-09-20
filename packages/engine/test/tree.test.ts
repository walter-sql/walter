import { describe, it, expect } from "vitest";
import {
  IncrementalHarness,
  recompute,
  viewToMap,
  mapsEqual,
  Rng
} from "./support";
import { planShape } from "../src/planner/plan";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import type { RowSource } from "../src/lazy/rowsource";
import { LazyTree } from "../src/lazy/lazy-tree";
import { applyView, pendingView, type View } from "@walter-sql/view";
import { keyOf, stableStringify } from "../src/ivm/zset";
import type {
  Expr,
  FromItem,
  OrderItem,
  Query,
  SelectItem,
  ShapeQuery
} from "../src/parser/ir";
import {
  applyTxn,
  catalogOf,
  commit,
  seedTree,
  withReads,
  type RowOp
} from "./support";
import type { Row } from "../src/ivm/zset";

const col = (name: string, table?: string): Expr => ({
  kind: "column",
  name,
  table
});
const tbl = (name: string, alias: string): FromItem => ({
  kind: "table",
  name,
  alias
});
const sel = (expr: Expr, alias: string): SelectItem => ({ expr, alias });
const ob = (expr: Expr, desc = false, nullsFirst = false): OrderItem => ({
  expr,
  desc,
  nullsFirst
});

function q(
  partial: Partial<Query> & { from: FromItem; select: SelectItem[] }
): Query {
  return {
    where: undefined,
    groupBy: [],
    having: undefined,
    distinct: false,
    orderBy: [],
    ...partial
  };
}

class TreeModel {
  private seq = 0;
  private readonly ids = new Map<string, number[]>();

  constructor(
    private readonly rng: Rng,
    private readonly fields: Record<string, (rng: Rng) => Row>
  ) {}

  private track(t: string, id: number): void {
    let arr = this.ids.get(t);
    if (!arr) this.ids.set(t, (arr = []));
    arr.push(id);
  }
  private existing(t: string): number | undefined {
    const arr = this.ids.get(t);
    if (!arr || arr.length === 0) return undefined;
    return arr[this.rng.int(arr.length)];
  }
  private forget(t: string, id: number): void {
    const arr = this.ids.get(t);
    if (arr) {
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  randomOp(t: string): RowOp | undefined {
    const roll = this.rng.next();
    const id = this.existing(t);
    if (roll < 0.5 || id === undefined) {
      const newRow = { id: ++this.seq, ...this.fields[t]!(this.rng) };
      this.track(t, newRow.id);
      return { table: t, kind: "insert", newRow };
    }
    if (roll < 0.8) {
      return {
        table: t,
        kind: "update",
        newRow: { ...this.fields[t]!(this.rng), id },
        oldRow: { id }
      };
    }
    this.forget(t, id);
    return { table: t, kind: "delete", oldRow: { id } };
  }
}

interface TreeCase {
  name: string;
  shape: ShapeQuery;
  columnTypes: Record<string, Record<string, string>>;
  pk: Record<string, string[]>;
  tables: string[];
  fields: Record<string, (rng: Rng) => Row>;
}

const DEPTH2: TreeCase = {
  name: "depth>=2 (comments -> replies -> reactions)",
  shape: {
    query: q({
      from: tbl("comments", "c"),
      select: [sel(col("id", "c"), "id"), sel(col("body", "c"), "body")]
    }),
    collections: [
      {
        field: "replies",
        parentKey: ["id"],
        childKey: ["comment_id"],
        object: false,
        node: {
          query: q({
            from: tbl("replies", "r"),
            select: [
              sel(col("id", "r"), "id"),
              sel(col("body", "r"), "body"),
              sel(col("comment_id", "r"), "comment_id")
            ]
          }),
          collections: [
            {
              field: "reactions",
              parentKey: ["id"],
              childKey: ["reply_id"],
              object: false,
              node: {
                query: q({
                  from: tbl("reactions", "x"),
                  select: [
                    sel(col("id", "x"), "id"),
                    sel(col("emoji", "x"), "emoji"),
                    sel(col("reply_id", "x"), "reply_id")
                  ]
                }),
                collections: []
              }
            }
          ]
        }
      }
    ]
  },
  columnTypes: {
    comments: { id: "int4", body: "text" },
    replies: { id: "int4", comment_id: "int4", body: "text" },
    reactions: { id: "int4", reply_id: "int4", emoji: "text" }
  },
  pk: { comments: ["id"], replies: ["id"], reactions: ["id"] },
  tables: ["comments", "replies", "reactions"],
  fields: {
    comments: rng => ({ body: rng.pick(["a", "b", "c"]) }),
    replies: rng => ({
      comment_id: 1 + rng.int(8),
      body: rng.pick(["x", "y"])
    }),
    reactions: rng => ({
      reply_id: 1 + rng.int(14),
      emoji: rng.pick(["👍", "🔥", "🎉"])
    })
  }
};

const PER_PARENT_LIMIT: TreeCase = {
  name: "per-parent ORDER BY + LIMIT (top-2 replies per comment)",
  shape: {
    query: q({
      from: tbl("comments", "c"),
      select: [sel(col("id", "c"), "id"), sel(col("body", "c"), "body")]
    }),
    collections: [
      {
        field: "replies",
        parentKey: ["id"],
        childKey: ["comment_id"],
        object: false,
        node: {
          query: q({
            from: tbl("replies", "r"),
            select: [
              sel(col("id", "r"), "id"),
              sel(col("body", "r"), "body"),
              sel(col("comment_id", "r"), "comment_id")
            ],
            orderBy: [ob(col("id", "r"), true)],
            limit: 2
          }),
          collections: []
        }
      }
    ]
  },
  columnTypes: {
    comments: { id: "int4", body: "text" },
    replies: { id: "int4", comment_id: "int4", body: "text" }
  },
  pk: { comments: ["id"], replies: ["id"] },
  tables: ["comments", "replies"],
  fields: {
    comments: rng => ({ body: rng.pick(["a", "b", "c"]) }),
    replies: rng => ({
      comment_id: 1 + rng.int(6),
      body: rng.pick(["x", "y", "z"])
    })
  }
};

const PER_PARENT_JOIN: TreeCase = {
  name: "per-parent window over a join (top-2 comments per post by author name)",
  shape: {
    query: q({
      from: tbl("posts", "p"),
      select: [sel(col("id", "p"), "id"), sel(col("title", "p"), "title")]
    }),
    collections: [
      {
        field: "comments",
        parentKey: ["id"],
        childKey: ["post_id"],
        object: false,
        node: {
          query: q({
            from: {
              kind: "join",
              joinType: "inner",
              left: tbl("comments", "m"),
              right: tbl("users", "u"),
              on: {
                kind: "binary",
                op: "=",
                left: col("id", "u"),
                right: col("user_id", "m")
              }
            },
            select: [
              sel(col("id", "m"), "id"),
              sel(col("post_id", "m"), "post_id"),
              sel(col("name", "u"), "name")
            ],
            orderBy: [ob(col("name", "u"))],
            limit: 2
          }),
          collections: []
        }
      }
    ]
  },
  columnTypes: {
    posts: { id: "int4", title: "text" },
    comments: { id: "int4", post_id: "int4", user_id: "int4" },
    users: { id: "int4", name: "text", bio: "text" }
  },
  pk: { posts: ["id"], comments: ["id"], users: ["id"] },
  tables: ["posts", "comments", "users"],
  fields: {
    posts: rng => ({ title: rng.pick(["t1", "t2"]) }),
    comments: rng => ({
      post_id: 1 + rng.int(8),
      user_id: 1 + rng.int(12)
    }),
    users: rng => ({
      name: rng.pick(["Ann", "bob", "Ä", "zoé", null]),
      bio: rng.pick(["x", "y"])
    })
  }
};

const SELF_REF: TreeCase = {
  name: "self-referential (node parent_id at three levels)",
  shape: {
    query: q({
      from: tbl("node", "n"),
      where: { kind: "isNull", operand: col("parent_id", "n"), negated: false },
      select: [sel(col("id", "n"), "id"), sel(col("label", "n"), "label")]
    }),
    collections: [
      {
        field: "children",
        parentKey: ["id"],
        childKey: ["parent_id"],
        object: false,
        node: {
          query: q({
            from: tbl("node", "c"),
            select: [
              sel(col("id", "c"), "id"),
              sel(col("label", "c"), "label"),
              sel(col("parent_id", "c"), "parent_id")
            ]
          }),
          collections: [
            {
              field: "children",
              parentKey: ["id"],
              childKey: ["parent_id"],
              object: false,
              node: {
                query: q({
                  from: tbl("node", "g"),
                  select: [
                    sel(col("id", "g"), "id"),
                    sel(col("label", "g"), "label"),
                    sel(col("parent_id", "g"), "parent_id")
                  ]
                }),
                collections: []
              }
            }
          ]
        }
      }
    ]
  },
  columnTypes: { node: { id: "int4", parent_id: "int4", label: "text" } },
  pk: { node: ["id"] },
  tables: ["node"],
  fields: {
    node: rng => ({
      parent_id: rng.next() < 0.4 ? null : 1 + rng.int(12),
      label: rng.pick(["p", "q", "r", "s"])
    })
  }
};

const CASES = [DEPTH2, PER_PARENT_LIMIT, SELF_REF, PER_PARENT_JOIN];

function rowsToMap(rows: Row[], cols: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of rows) out.set(keyOf(v, cols), stableStringify(v));
  return out;
}

describe("shape trees: dataflow incremental == recompute", () => {
  for (const tc of CASES) {
    it(tc.name, () => {
      for (const seed of [1, 7, 4242]) {
        const rng = new Rng(seed);
        const model = new TreeModel(rng, tc.fields);
        const h = IncrementalHarness.fromShape(
          tc.shape,
          [],
          { columnTypes: tc.columnTypes },
          tc.pk
        );

        for (let txn = 0; txn < 180; txn++) {
          const ops: RowOp[] = [];
          for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
            const op = model.randomOp(rng.pick(tc.tables));
            if (op) ops.push(op);
          }
          h.applyOps(ops);
          const diff = mapsEqual(h.incremental(), h.recomputed());
          expect(
            diff,
            `${tc.name} seed=${seed} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    });
  }
});

describe("shape trees: client patcher round-trip (positional protocol)", () => {
  for (const tc of CASES) {
    it(tc.name, () => {
      for (const seed of [1, 7]) {
        const rng = new Rng(seed);
        const model = new TreeModel(rng, tc.fields);
        const h = IncrementalHarness.fromShape(
          tc.shape,
          [],
          { columnTypes: tc.columnTypes },
          tc.pk
        );
        let view: View = pendingView;

        for (let txn = 0; txn < 140; txn++) {
          const ops: RowOp[] = [];
          for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
            const op = model.randomOp(rng.pick(tc.tables));
            if (op) ops.push(op);
          }
          const changes = h.applyOps(ops);
          view = applyView(view, { type: "diff", shapeId: "s", changes });

          const diff = mapsEqual(rowsToMap(view.rows, ["id"]), h.recomputed());
          expect(
            diff,
            `${tc.name} seed=${seed} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    });
  }
});

describe("shape trees: lazy (correlation-pulled) incremental == recompute", () => {
  for (const tc of CASES) {
    it(tc.name, async () => {
      for (const seed of [2, 19]) {
        const rng = new Rng(seed);
        const model = new TreeModel(rng, tc.fields);
        const state = new StateStore();
        for (const [t, cols] of Object.entries(tc.pk))
          state.setKeyColumns(t, cols);

        const opts = {
          columnTypes: tc.columnTypes,
          keyColumnsByTable: tc.pk
        };
        const plan = planShape(tc.shape, [], catalogOf(opts));
        const lazy = new LazyTree(
          plan,
          [],
          new MemRowSource(t => state.rows(t))
        );

        const initial: RowOp[] = [];
        for (let i = 0; i < 24; i++) {
          const op = model.randomOp(rng.pick(tc.tables));
          if (op?.kind === "insert") initial.push(op);
        }
        state.ingest(initial);
        await seedTree(lazy);

        let diff = mapsEqual(
          viewToMap(lazy.materializer),
          recompute(tc.shape, [], opts, state)
        );
        expect(
          diff,
          `${tc.name} seed=${seed} after-seed: ${diff}`
        ).toBeUndefined();

        for (let txn = 0; txn < 160; txn++) {
          const ops: RowOp[] = [];
          for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
            const op = model.randomOp(rng.pick(tc.tables));
            if (op) ops.push(op);
          }
          state.ingest(ops);
          await applyTxn(lazy, commit(txn + 1, ops));

          diff = mapsEqual(
            viewToMap(lazy.materializer),
            recompute(tc.shape, [], opts, state)
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

describe("per-parent windowed join: maintenance is change-driven", () => {
  it("charges only the partitions a change touches", async () => {
    const tc = PER_PARENT_JOIN;
    const state = new StateStore();
    for (const [t, cols] of Object.entries(tc.pk)) state.setKeyColumns(t, cols);
    const opts = { columnTypes: tc.columnTypes, keyColumnsByTable: tc.pk };
    const plan = planShape(tc.shape, [], catalogOf(opts));

    const mem = new MemRowSource(t => state.rows(t));
    let fetches = 0;
    const counting = withReads(mem, {
      fetchWhereIn: (t, c, k) => (fetches++, mem.fetchWhereIn(t, c, k)),
      fetchWindow: r => (fetches++, mem.fetchWindow(r))
    });

    const initial: RowOp[] = [];
    let cid = 0;
    for (let p = 1; p <= 20; p++) {
      initial.push({
        table: "posts",
        kind: "insert",
        newRow: { id: p, title: "t" }
      });
      for (let k = 0; k < 3; k++) {
        const uid = (p - 1) * 3 + k + 1;
        initial.push({
          table: "users",
          kind: "insert",
          newRow: {
            id: uid,
            name: `user${String(uid).padStart(2, "0")}`,
            bio: "x"
          }
        });
        initial.push({
          table: "comments",
          kind: "insert",
          newRow: { id: ++cid, post_id: p, user_id: uid }
        });
      }
    }
    state.ingest(initial);

    const lazy = new LazyTree(plan, [], counting);
    await seedTree(lazy);
    const check = () =>
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(tc.shape, [], opts, state)
      );
    expect(check()).toBeUndefined();

    const topk = plan.root.collections[0]!.level.window!.topk;
    const origEntries = topk.groupEntries.bind(topk);
    let walks = 0;
    topk.groupEntries = gk => (walks++, origEntries(gk));

    const apply = async (ops: RowOp[]) => {
      state.ingest(ops);
      fetches = 0;
      walks = 0;
      const out = await applyTxn(lazy, commit(1000 + cid++, ops));
      expect(check()).toBeUndefined();
      return out;
    };

    const bio = await apply([
      {
        table: "users",
        kind: "update",
        newRow: { id: 5, name: "user05", bio: "y" },
        oldRow: { id: 5, name: "user05", bio: "x" }
      }
    ]);
    expect(bio).toEqual([]);
    expect(fetches).toBe(0);
    expect(walks).toBe(0);

    const rename = await apply([
      {
        table: "users",
        kind: "update",
        newRow: { id: 5, name: "aaa", bio: "y" },
        oldRow: { id: 5, name: "user05", bio: "y" }
      }
    ]);
    expect(rename.length).toBeGreaterThan(0);
    expect(fetches).toBe(1);
    expect(walks).toBeLessThanOrEqual(3);

    const insert = await apply([
      {
        table: "comments",
        kind: "insert",
        newRow: { id: ++cid, post_id: 7, user_id: 19 }
      }
    ]);
    expect(insert.length).toBeGreaterThan(0);
    expect(fetches).toBe(0);
    expect(walks).toBeLessThanOrEqual(3);
  });
});

describe("materialized order is type-faithful", () => {
  const events = [
    { id: 1, at: "0099-06-01 12:00:00 BC" },
    { id: 2, at: "0100-06-01 12:00:00 BC" },
    { id: 3, at: "9999-01-01 00:00:00" },
    { id: 4, at: "30000-01-01 00:00:00" }
  ];
  const shape: ShapeQuery = {
    query: q({
      from: tbl("events", "e"),
      select: [sel(col("id", "e"), "id"), sel(col("at", "e"), "at")],
      orderBy: [ob(col("at", "e"))]
    }),
    collections: []
  };
  const opts = {
    columnTypes: { events: { id: "int4", at: "timestamp" } }
  };

  it("orders ASC by a timestamp column chronologically", () => {
    const h = IncrementalHarness.fromShape(shape, [], opts, { events: ["id"] });
    h.seed(events.map(newRow => ({ table: "events", kind: "insert", newRow })));
    expect(h.snapshotRows().map(r => r.id)).toEqual([2, 1, 3, 4]);
  });
});

const WIN_SHAPE: ShapeQuery = {
  query: q({
    from: tbl("comments", "c"),
    select: [sel(col("id", "c"), "id"), sel(col("body", "c"), "body")]
  }),
  collections: [
    {
      field: "replies",
      parentKey: ["id"],
      childKey: ["comment_id"],
      object: false,
      node: {
        query: q({
          from: tbl("replies", "r"),
          select: [
            sel(col("id", "r"), "id"),
            sel(col("score", "r"), "score"),
            sel(col("comment_id", "r"), "comment_id")
          ],
          orderBy: [ob(col("score", "r"), true)],
          limit: 3
        }),
        collections: []
      }
    }
  ]
};
const WIN_TYPES = {
  comments: { id: "int4", body: "text" },
  replies: { id: "int4", comment_id: "int4", score: "int4", body: "text" }
};
const WIN_PK = { comments: ["id"], replies: ["id"] };
const WIN_OPTS = {
  columnTypes: WIN_TYPES,
  keyColumnsByTable: WIN_PK
};
const WIN_PAGE = 3 + Math.max(16, 3 >> 1);

class WindowCountingSource {
  windowCalls = 0;
  partsRequested: (readonly unknown[])[] = [];
  rowsByPart = new Map<string, number>();
  readonly source: RowSource;
  constructor(getRows: (t: string) => Iterable<Row>) {
    const inner = new MemRowSource(getRows);
    this.source = withReads(inner, {
      fetchWindow: async req => {
        this.windowCalls++;
        for (const p of req.partitions) this.partsRequested.push(p.value);
        const res = await inner.fetchWindow(req);
        const cols = req.correlationColumns;
        for (const r of res.rows) {
          const k = cols.map(c => String(r[c])).join(",");
          this.rowsByPart.set(k, (this.rowsByPart.get(k) ?? 0) + 1);
        }
        return res;
      }
    });
  }
}

describe("per-parent window: keyset refill, no whole-window refetch", () => {
  it("pages each parent independently after its own cursor, bounded", async () => {
    const state = new StateStore();
    for (const [t, cols] of Object.entries(WIN_PK))
      state.setKeyColumns(t, cols);

    const initial: RowOp[] = [];
    for (const cid of [1, 2, 3])
      initial.push({
        table: "comments",
        kind: "insert",
        newRow: { id: cid, body: `c${cid}` }
      });
    for (const cid of [1, 2, 3])
      for (let i = 1; i <= 30; i++) {
        const id = (cid - 1) * 30 + i;
        initial.push({
          table: "replies",
          kind: "insert",
          newRow: { id, comment_id: cid, score: id, body: "x" }
        });
      }
    state.ingest(initial);

    const src = new WindowCountingSource(t => state.rows(t));
    const plan = planShape(WIN_SHAPE, [], catalogOf(WIN_OPTS));
    const lazy = new LazyTree(plan, [], src.source);
    await seedTree(lazy);

    expect(src.windowCalls).toBe(1);
    expect(lazy.workingSetSize).toBeLessThanOrEqual(3 * WIN_PAGE + 3);
    expect(
      mapsEqual(
        viewToMap(lazy.materializer),
        recompute(WIN_SHAPE, [], WIN_OPTS, state)
      )
    ).toBeUndefined();

    src.windowCalls = 0;
    src.partsRequested = [];
    src.rowsByPart.clear();

    let txn = 0;
    for (;;) {
      const alive = [...state.rows("replies")]
        .filter(r => r.comment_id === 1)
        .sort((a, b) => (b.score as number) - (a.score as number))
        .slice(0, 3);
      if (alive.length === 0) break;
      const ops: RowOp[] = alive.map(r => ({
        table: "replies",
        kind: "delete" as const,
        oldRow: { id: r.id }
      }));
      state.ingest(ops);
      await applyTxn(lazy, commit(++txn, ops));

      expect(
        mapsEqual(
          viewToMap(lazy.materializer),
          recompute(WIN_SHAPE, [], WIN_OPTS, state)
        ),
        `round ${txn}`
      ).toBeUndefined();
      expect(lazy.workingSetSize).toBeLessThanOrEqual(3 * WIN_PAGE + 3);
    }

    expect(src.windowCalls).toBeGreaterThanOrEqual(1);
    expect(src.partsRequested.every(v => v[0] === 1)).toBe(true);
    expect(src.rowsByPart.has("2")).toBe(false);
    expect(src.rowsByPart.has("3")).toBe(false);
    expect(src.rowsByPart.get("1") ?? 0).toBeLessThanOrEqual(WIN_PAGE);
  });

  it("incremental == recompute under churn that moves children between parents", async () => {
    for (const seed of [3, 17, 8675]) {
      const rng = new Rng(seed);
      const state = new StateStore();
      for (const [t, cols] of Object.entries(WIN_PK))
        state.setKeyColumns(t, cols);

      const initial: RowOp[] = [];
      for (const cid of [1, 2, 3, 4])
        initial.push({
          table: "comments",
          kind: "insert",
          newRow: { id: cid, body: `c${cid}` }
        });
      let seq = 1000;
      const replyIds: number[] = [];
      for (let i = 0; i < 40; i++) {
        const id = seq++;
        replyIds.push(id);
        initial.push({
          table: "replies",
          kind: "insert",
          newRow: {
            id,
            comment_id: 1 + rng.int(4),
            score: rng.int(50),
            body: "x"
          }
        });
      }
      state.ingest(initial);

      const plan = planShape(WIN_SHAPE, [], catalogOf(WIN_OPTS));
      const lazy = new LazyTree(plan, [], new MemRowSource(t => state.rows(t)));
      await seedTree(lazy);
      expect(
        mapsEqual(
          viewToMap(lazy.materializer),
          recompute(WIN_SHAPE, [], WIN_OPTS, state)
        ),
        `seed=${seed}`
      ).toBeUndefined();

      for (let txn = 0; txn < 200; txn++) {
        const roll = rng.next();
        const ops: RowOp[] = [];
        if (roll < 0.5 || replyIds.length === 0) {
          const id = seq++;
          replyIds.push(id);
          ops.push({
            table: "replies",
            kind: "insert",
            newRow: {
              id,
              comment_id: 1 + rng.int(4),
              score: rng.int(50),
              body: "x"
            }
          });
        } else if (roll < 0.8) {
          const id = replyIds[rng.int(replyIds.length)]!;
          ops.push({
            table: "replies",
            kind: "update",
            newRow: {
              id,
              comment_id: 1 + rng.int(4),
              score: rng.int(50),
              body: "x"
            },
            oldRow: { id }
          });
        } else {
          const i = rng.int(replyIds.length);
          const id = replyIds.splice(i, 1)[0]!;
          ops.push({ table: "replies", kind: "delete", oldRow: { id } });
        }
        state.ingest(ops);
        await applyTxn(lazy, commit(txn + 1, ops));
        expect(
          mapsEqual(
            viewToMap(lazy.materializer),
            recompute(WIN_SHAPE, [], WIN_OPTS, state)
          ),
          `seed=${seed} txn=${txn}`
        ).toBeUndefined();
      }
    }
  });
});
