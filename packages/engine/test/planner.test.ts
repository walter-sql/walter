import { describe, it, expect } from "vitest";
import { IncrementalHarness, compileShape, mapsEqual } from "./support";
import { keyOf, stableStringify } from "../src/ivm/zset";
import type { RowOp } from "./support";

const ins = (table: string, newRow: Record<string, unknown>): RowOp => ({
  table,
  kind: "insert",
  newRow
});
const upd = (
  table: string,
  newRow: Record<string, unknown>,
  id: number
): RowOp => ({
  table,
  kind: "update",
  newRow,
  oldRow: { id }
});
const del = (table: string, id: number): RowOp => ({
  table,
  kind: "delete",
  oldRow: { id }
});

const PK = { users: ["id"], comments: ["id"], replies: ["id"] };

describe("select-project-filter", () => {
  it("filters by a parameter and projects", async () => {
    const h = await IncrementalHarness.create(
      "SELECT id, body FROM comments WHERE room_id = $1",
      [1],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, room_id: 1, body: "a", user_id: 1 }),
      ins("comments", { id: 2, room_id: 2, body: "b", user_id: 1 }),
      ins("comments", { id: 3, room_id: 1, body: "c", user_id: 2 })
    ]);
    expect(h.incremental()).toEqual(
      new Map([
        [JSONKey({ id: 1 }), JSONVal({ id: 1, body: "a" })],
        [JSONKey({ id: 3 }), JSONVal({ id: 3, body: "c" })]
      ])
    );
    h.applyOps([
      upd("comments", { id: 3, room_id: 9, body: "c", user_id: 2 }, 3)
    ]);
    expect(h.incremental().has(JSONKey({ id: 3 }))).toBe(false);
    expectConsistent(h);
  });
});

describe("inner join", () => {
  it("resolves a foreign key to columns", async () => {
    const h = await IncrementalHarness.create(
      "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "Ann" }),
      ins("comments", { id: 10, user_id: 1, body: "hi" })
    ]);
    expect(h.incremental().get(JSONKey({ id: 10 }))).toBe(
      JSONVal({ id: 10, body: "hi", name: "Ann" })
    );

    h.applyOps([upd("users", { id: 1, name: "Anne" }, 1)]);
    expect(h.incremental().get(JSONKey({ id: 10 }))).toBe(
      JSONVal({ id: 10, body: "hi", name: "Anne" })
    );

    h.applyOps([ins("comments", { id: 11, user_id: 99, body: "orphan" })]);
    expect(h.incremental().has(JSONKey({ id: 11 }))).toBe(false);
    expectConsistent(h);
  });
});

describe("derived identity (key inference)", () => {
  const keyOfSql = async (sql: string): Promise<string[]> =>
    (await IncrementalHarness.create(sql, [], {}, PK)).plan.root.keyColumns;

  it("discharges a to-one join: the pinned table's PK leaves the key", async () => {
    expect(
      await keyOfSql(
        "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id"
      )
    ).toEqual(["id"]);
  });

  it("keeps both PKs across a to-many join", async () => {
    expect(
      await keyOfSql(
        "SELECT c.id AS id, r.id AS rid, r.body AS body FROM comments c JOIN replies r ON r.comment_id = c.id"
      )
    ).toEqual(["id", "rid"]);
  });

  it("falls back to content identity when a multiplicity-bearing PK is unprojected", async () => {
    expect(
      await keyOfSql(
        "SELECT c.id AS id, r.body AS body FROM comments c JOIN replies r ON r.comment_id = c.id"
      )
    ).toEqual([]);
  });

  it("never discharges the non-nullable side of a LEFT JOIN through its ON", async () => {
    expect(
      await keyOfSql(
        "SELECT u.name AS name, c.body AS body FROM users u LEFT JOIN comments c ON u.id = c.user_id"
      )
    ).toEqual([]);
  });

  it("discharges a join pinned by a unique key, not the PK", async () => {
    const sql =
      "SELECT c.id AS id, u.name AS name FROM comments c JOIN users u ON u.name = c.body";
    const keyWith = async (unique?: Record<string, string[][]>) =>
      (
        await IncrementalHarness.create(
          sql,
          [],
          { uniqueKeysByTable: unique },
          PK
        )
      ).plan.root.keyColumns;
    expect(await keyWith({ users: [["name"]] })).toEqual(["id"]);
    expect(await keyWith()).toEqual([]);
  });

  it("discharges transitively along a chain of to-one joins", async () => {
    expect(
      await keyOfSql(
        "SELECT r.id AS id, u.name AS name FROM replies r " +
          "JOIN comments c ON c.id = r.comment_id " +
          "JOIN users u ON u.id = c.user_id"
      )
    ).toEqual(["id"]);
  });
});

describe("nested relational output (LEFT JOIN + json_agg)", () => {
  const sql =
    "SELECT c.id AS id, c.body AS body, " +
    "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
    "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id GROUP BY c.id";

  it("builds nested arrays and emits fine-grained child patches", async () => {
    const h = await IncrementalHarness.create(sql, [], {}, PK);
    h.seed([
      ins("comments", { id: 1, body: "post" }),
      ins("replies", { id: 100, comment_id: 1, body: "first" })
    ]);
    expect(h.incremental().get(JSONKey({ id: 1 }))).toBe(
      JSONVal({ id: 1, body: "post", replies: [{ id: 100, body: "first" }] })
    );

    h.applyOps([ins("comments", { id: 2, body: "lonely" })]);
    expect(h.incremental().get(JSONKey({ id: 2 }))).toBe(
      JSONVal({ id: 2, body: "lonely", replies: [] })
    );

    const changes = h.applyOps([
      ins("replies", { id: 101, comment_id: 1, body: "second" })
    ]);
    const patch = changes.find(c => c.op === "update" && c.index === 0);
    expect(patch).toBeDefined();
    if (patch && patch.op === "update") {
      expect(patch.ops).toContainEqual({
        op: "nest",
        field: "replies",
        ops: [{ op: "add", value: { id: 101, body: "second" } }]
      });
    }
    expect(h.incremental().get(JSONKey({ id: 1 }))).toBe(
      JSONVal({
        id: 1,
        body: "post",
        replies: [
          { id: 100, body: "first" },
          { id: 101, body: "second" }
        ]
      })
    );

    const changes2 = h.applyOps([
      upd("replies", { id: 100, comment_id: 1, body: "edited" }, 100)
    ]);
    const patch2 = changes2.find(c => c.op === "update");
    expect(
      patch2 &&
        patch2.op === "update" &&
        patch2.ops.some(
          o =>
            o.op === "nest" &&
            o.field === "replies" &&
            o.ops.some(
              i =>
                i.op === "update" &&
                i.index === 0 &&
                i.ops.some(
                  f =>
                    f.op === "set" && f.field === "body" && f.value === "edited"
                )
            )
        )
    ).toBe(true);

    const changes3 = h.applyOps([del("replies", 101)]);
    const patch3 = changes3.find(c => c.op === "update");
    expect(
      patch3 &&
        patch3.op === "update" &&
        patch3.ops.some(
          o => o.op === "nest" && o.ops.some(i => i.op === "remove")
        )
    ).toBe(true);
    expectConsistent(h);
  });
});

describe("group by aggregates", () => {
  it("maintains count/sum/max per group", async () => {
    const h = await IncrementalHarness.create(
      "SELECT user_id AS user_id, count(*) AS n, sum(score) AS total, max(score) AS top FROM comments GROUP BY user_id",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, user_id: 1, score: 5 }),
      ins("comments", { id: 2, user_id: 1, score: 3 }),
      ins("comments", { id: 3, user_id: 2, score: 8 })
    ]);
    expect(h.incremental().get(JSONKey({ user_id: 1 }))).toBe(
      JSONVal({ user_id: 1, n: "2", total: "8", top: 5 })
    );
    expect(h.incremental().get(JSONKey({ user_id: 2 }))).toBe(
      JSONVal({ user_id: 2, n: "1", total: "8", top: 8 })
    );

    h.applyOps([del("comments", 3)]);
    expect(h.incremental().has(JSONKey({ user_id: 2 }))).toBe(false);

    h.applyOps([del("comments", 1)]);
    expect(h.incremental().get(JSONKey({ user_id: 1 }))).toBe(
      JSONVal({ user_id: 1, n: "1", total: "3", top: 3 })
    );
    expectConsistent(h);
  });

  it("sum/avg recover exactly after non-finite rows retract", async () => {
    const h = await IncrementalHarness.create(
      "SELECT room_id AS room_id, sum(rating) AS total FROM totals GROUP BY room_id",
      [],
      {},
      { totals: ["id"] }
    );
    h.seed([
      ins("totals", { id: 1, room_id: 1, rating: 1.5 }),
      ins("totals", { id: 2, room_id: 1, rating: "NaN" }),
      ins("totals", { id: 3, room_id: 1, rating: "Infinity" }),
      ins("totals", { id: 4, room_id: 1, rating: "-Infinity" })
    ]);
    const expectTotal = (total: unknown) =>
      expect(h.incremental().get(JSONKey({ room_id: 1 }))).toBe(
        JSONVal({ room_id: 1, total })
      );
    expectTotal("NaN");
    h.applyOps([del("totals", 2)]);
    expectTotal("NaN");
    h.applyOps([del("totals", 4)]);
    expectTotal("Infinity");
    h.applyOps([del("totals", 3)]);
    expectTotal(1.5);
    expectConsistent(h);
  });

  it("float sums are exact under retraction, not a running-sum residue", async () => {
    const h = await IncrementalHarness.create(
      "SELECT room_id AS room_id, sum(rating) AS total, avg(rating) AS mean " +
        "FROM totals GROUP BY room_id",
      [],
      {},
      { totals: ["id"] }
    );
    h.seed([
      ins("totals", { id: 1, room_id: 1, rating: 1e16 }),
      ins("totals", { id: 2, room_id: 1, rating: 1 })
    ]);
    h.applyOps([del("totals", 1)]);
    expect(h.incremental().get(JSONKey({ room_id: 1 }))).toBe(
      JSONVal({ room_id: 1, total: 1, mean: 1 })
    );
    expectConsistent(h);
  });

  it("sum(DISTINCT float8) is a function of the set, not insertion order", async () => {
    const rows = [0.1, 0.2, 0.3].map((rating, i) =>
      ins("totals", { id: i + 1, room_id: 1, rating })
    );
    for (const order of [rows, [...rows].reverse()]) {
      const h = await IncrementalHarness.create(
        "SELECT room_id AS room_id, sum(DISTINCT rating) AS total " +
          "FROM totals GROUP BY room_id",
        [],
        {},
        { totals: ["id"] }
      );
      h.seed(order);
      expect(h.incremental().get(JSONKey({ room_id: 1 }))).toBe(
        JSONVal({ room_id: 1, total: 0.6 })
      );
    }
  });

  it("float sum overflow raises PG's error instead of emitting a value", async () => {
    const h = await IncrementalHarness.create(
      "SELECT room_id AS room_id, sum(rating) AS total FROM totals GROUP BY room_id",
      [],
      {},
      { totals: ["id"] }
    );
    h.seed([ins("totals", { id: 1, room_id: 1, rating: 1.5e308 })]);
    expect(() =>
      h.applyOps([ins("totals", { id: 2, room_id: 1, rating: 1e308 })])
    ).toThrow(/value out of range: overflow/);
  });

  it("keeps aggregates differing only in FILTER distinct", async () => {
    const h = await IncrementalHarness.create(
      "SELECT user_id AS user_id, count(*) AS n, " +
        "count(*) FILTER (WHERE score > 5) AS hi, " +
        "count(*) FILTER (WHERE score <= 5) AS lo " +
        "FROM comments GROUP BY user_id",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, user_id: 1, score: 10 }),
      ins("comments", { id: 2, user_id: 1, score: 7 }),
      ins("comments", { id: 3, user_id: 1, score: 3 })
    ]);
    expect(h.incremental().get(JSONKey({ user_id: 1 }))).toBe(
      JSONVal({ user_id: 1, n: "3", hi: "2", lo: "1" })
    );

    h.applyOps([del("comments", 2)]);
    expect(h.incremental().get(JSONKey({ user_id: 1 }))).toBe(
      JSONVal({ user_id: 1, n: "2", hi: "1", lo: "1" })
    );
    h.applyOps([del("comments", 3)]);
    expect(h.incremental().get(JSONKey({ user_id: 1 }))).toBe(
      JSONVal({ user_id: 1, n: "1", hi: "1", lo: "0" })
    );
    expectConsistent(h);
  });

  it("keeps json_agg differing only in ORDER BY or FILTER distinct", async () => {
    const h = await IncrementalHarness.create(
      "SELECT room_id AS room_id, " +
        "json_agg(body ORDER BY score ASC) AS up, " +
        "json_agg(body ORDER BY score DESC) AS down, " +
        "json_agg(body ORDER BY score ASC) FILTER (WHERE score > 5) AS hot " +
        "FROM comments GROUP BY room_id",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, room_id: 1, body: "a", score: 1 }),
      ins("comments", { id: 2, room_id: 1, body: "b", score: 5 }),
      ins("comments", { id: 3, room_id: 1, body: "c", score: 9 })
    ]);
    expect(h.incremental().get(JSONKey({ room_id: 1 }))).toBe(
      JSONVal({
        room_id: 1,
        up: ["a", "b", "c"],
        down: ["c", "b", "a"],
        hot: ["c"]
      })
    );

    h.applyOps([ins("comments", { id: 4, room_id: 1, body: "d", score: 7 })]);
    expect(h.incremental().get(JSONKey({ room_id: 1 }))).toBe(
      JSONVal({
        room_id: 1,
        up: ["a", "b", "d", "c"],
        down: ["c", "d", "b", "a"],
        hot: ["d", "c"]
      })
    );
    expectConsistent(h);
  });
});

describe("grouping rule (ungrouped columns)", () => {
  it("expression GROUP BY does not over-group (lower(name) counts case-insensitively)", async () => {
    const h = await IncrementalHarness.create(
      "SELECT lower(name) AS x, count(*) AS n FROM users GROUP BY lower(name)",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("users", { id: 2, name: "ALICE" })
    ]);
    expect(h.snapshotRows()).toEqual([{ x: "alice", n: "2" }]);
    expectConsistent(h);
  });

  it("a grouped column inside an expression is grouped", async () => {
    const h = await IncrementalHarness.create(
      "SELECT lower(body) AS x, count(*) AS n FROM comments GROUP BY body",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, body: "A" }),
      ins("comments", { id: 2, body: "A" })
    ]);
    expect(h.snapshotRows()).toEqual([{ x: "a", n: "2" }]);
    expectConsistent(h);
  });

  it("PK-grouped tables admit their bare columns (functional dependence)", async () => {
    const h = await IncrementalHarness.create(
      "SELECT id AS id, name AS name, count(*) AS n FROM users GROUP BY id",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "Ann" }),
      ins("users", { id: 2, name: "Ann" })
    ]);
    expect(h.incremental().get(JSONKey({ id: 1 }))).toBe(
      JSONVal({ id: 1, name: "Ann", n: "1" })
    );
    expectConsistent(h);
  });

  it("non-dependent bare columns reject at planning, as in Postgres", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT room_id AS room_id, score AS score, count(*) AS n FROM comments GROUP BY room_id",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"comments.score" must appear in the GROUP BY clause/);
  });

  it("a global aggregate rejects bare columns with the grouping message", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT name, count(*) AS n FROM users",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"users.name" must appear in the GROUP BY clause/);
  });

  it("dependence does not cross a join equality", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT u.name AS name, count(*) AS n FROM comments c " +
          "JOIN users u ON u.id = c.user_id GROUP BY c.user_id",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"u.name" must appear in the GROUP BY clause/);
  });

  it("a unique key is not a dependence witness (PK only, as in Postgres)", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT id AS id, count(*) AS n FROM users GROUP BY name",
        [],
        { uniqueKeysByTable: { users: [["name"]] } },
        PK
      )
    ).rejects.toThrow(/"users.id" must appear in the GROUP BY clause/);
  });

  it("a PK inside an expression is not a dependence witness", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT name, count(*) AS n FROM users GROUP BY id + 0",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"users.name" must appear in the GROUP BY clause/);
  });

  it("HAVING and ORDER BY obey the same rule", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT room_id AS room_id, count(*) AS n FROM comments GROUP BY room_id HAVING score > 1",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"comments.score" must appear in the GROUP BY clause/);
    await expect(
      IncrementalHarness.create(
        "SELECT count(*) AS n FROM users ORDER BY name",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/"users.name" must appear in the GROUP BY clause/);
  });

  it("qualified GROUP BY spelling keys the level (canonical qualification)", async () => {
    const h = await IncrementalHarness.create(
      "SELECT name, count(*) AS n FROM users GROUP BY users.name",
      [],
      {},
      PK
    );
    expect(h.plan.root.keyColumns).toEqual(["name"]);
  });

  it("a group key wider than the select falls back to content identity", async () => {
    const h = await IncrementalHarness.create(
      "SELECT body AS a, count(*) AS n FROM comments GROUP BY body, room_id",
      [],
      {},
      PK
    );
    expect(h.plan.root.keyColumns).toEqual([]);
    h.seed([
      ins("comments", { id: 1, room_id: 1, body: "x" }),
      ins("comments", { id: 2, room_id: 2, body: "x" }),
      ins("comments", { id: 3, room_id: 2, body: "x" })
    ]);
    expect(new Set(h.snapshotRows().map(r => JSON.stringify(r)))).toEqual(
      new Set(['{"a":"x","n":"1"}', '{"a":"x","n":"2"}'])
    );
    expectConsistent(h);
  });
});

describe("distinct", () => {
  it("keeps one row per distinct value while any source row remains", async () => {
    const h = await IncrementalHarness.create(
      "SELECT DISTINCT room_id AS room_id FROM comments",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, room_id: 1 }),
      ins("comments", { id: 2, room_id: 1 }),
      ins("comments", { id: 3, room_id: 2 })
    ]);
    expect(h.incremental().size).toBe(2);
    h.applyOps([del("comments", 1)]);
    expect(h.incremental().size).toBe(2);
    h.applyOps([del("comments", 2)]);
    expect(h.incremental().size).toBe(1);
    expectConsistent(h);
  });

  it("rejects ORDER BY outside the select list (PG's DISTINCT rule)", async () => {
    await expect(
      IncrementalHarness.create(
        "SELECT DISTINCT name FROM users ORDER BY id",
        [],
        {},
        PK
      )
    ).rejects.toThrow(/ORDER BY expressions must appear in select list/);
  });

  it("stays distinct and ordered when ORDER BY is in the select list", async () => {
    const h = await IncrementalHarness.create(
      "SELECT DISTINCT name FROM users ORDER BY 1",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "b" }),
      ins("users", { id: 2, name: "a" }),
      ins("users", { id: 3, name: "a" })
    ]);
    expect(h.snapshotRows()).toEqual([{ name: "a" }, { name: "b" }]);
    h.applyOps([del("users", 2)]);
    expect(h.snapshotRows()).toEqual([{ name: "a" }, { name: "b" }]);
    h.applyOps([del("users", 3)]);
    expect(h.snapshotRows()).toEqual([{ name: "b" }]);
    expectConsistent(h);
  });

  it("accepts a qualified ORDER BY spelling of a selected column", async () => {
    const h = await IncrementalHarness.create(
      "SELECT DISTINCT name FROM users ORDER BY users.name DESC",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "a" }),
      ins("users", { id: 2, name: "b" })
    ]);
    expect(h.snapshotRows()).toEqual([{ name: "b" }, { name: "a" }]);
    expectConsistent(h);
  });
});

describe("order by + limit (top-k)", () => {
  it("maintains the top-k window under churn", async () => {
    const h = await IncrementalHarness.create(
      "SELECT id, score FROM comments WHERE room_id = $1 ORDER BY score DESC, id ASC LIMIT 2",
      [1],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, room_id: 1, score: 10 }),
      ins("comments", { id: 2, room_id: 1, score: 20 }),
      ins("comments", { id: 3, room_id: 1, score: 5 })
    ]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 1 }), JSONKey({ id: 2 })])
    );

    h.applyOps([ins("comments", { id: 4, room_id: 1, score: 30 })]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 2 }), JSONKey({ id: 4 })])
    );
    expectConsistent(h);
  });

  it("LIMIT ALL is no bound; LIMIT ALL OFFSET n keeps the offset", async () => {
    const seed = [
      ins("comments", { id: 1, room_id: 1, score: 10 }),
      ins("comments", { id: 2, room_id: 1, score: 20 }),
      ins("comments", { id: 3, room_id: 1, score: 5 })
    ];
    const all = await IncrementalHarness.create(
      "SELECT id FROM comments ORDER BY id LIMIT ALL",
      [],
      {},
      PK
    );
    all.seed(seed);
    expect(all.snapshotRows()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const offset = await IncrementalHarness.create(
      "SELECT id FROM comments ORDER BY id LIMIT ALL OFFSET 1",
      [],
      {},
      PK
    );
    offset.seed(seed);
    expect(offset.snapshotRows()).toEqual([{ id: 2 }, { id: 3 }]);
    expectConsistent(offset);
  });
});

describe("= ANY(array param) through the full pipeline", () => {
  it("folds in WHERE and stays consistent under churn", async () => {
    const h = await IncrementalHarness.create(
      "SELECT id FROM comments WHERE room_id = ANY ($1) ORDER BY id",
      [[1, 3]],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1, room_id: 1 }),
      ins("comments", { id: 2, room_id: 2 }),
      ins("comments", { id: 3, room_id: 3 })
    ]);
    expect(h.snapshotRows()).toEqual([{ id: 1 }, { id: 3 }]);
    h.applyOps([ins("comments", { id: 4, room_id: 3 })]);
    expect(h.snapshotRows()).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);
    expectConsistent(h);
  });

  it("folds inside join ON conditions", async () => {
    const h = await IncrementalHarness.create(
      "SELECT c.id AS id FROM comments c JOIN users u ON u.id = c.user_id AND u.name = ANY ($1)",
      [["alice"]],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "alice" }),
      ins("users", { id: 2, name: "bob" }),
      ins("comments", { id: 10, user_id: 1 }),
      ins("comments", { id: 20, user_id: 2 })
    ]);
    expect(h.snapshotRows()).toEqual([{ id: 10 }]);
    expectConsistent(h);
  });

  it("folds inside EXISTS subqueries", async () => {
    const h = await IncrementalHarness.create(
      "SELECT u.id AS id FROM users u WHERE EXISTS (SELECT 1 FROM comments c WHERE c.user_id = u.id AND c.body = ANY ($1))",
      [["hi"]],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1 }),
      ins("users", { id: 2 }),
      ins("comments", { id: 10, user_id: 1, body: "hi" }),
      ins("comments", { id: 20, user_id: 2, body: "bye" })
    ]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 1 })])
    );
    expectConsistent(h);
  });

  it("an empty array param yields the empty (but valid) shape", async () => {
    const h = await IncrementalHarness.create(
      "SELECT id FROM comments WHERE room_id = ANY ($1)",
      [[]],
      {},
      PK
    );
    h.seed([ins("comments", { id: 1, room_id: 1 })]);
    expect(h.snapshotRows()).toEqual([]);
    expectConsistent(h);
  });
});

describe("exists (semi-join)", () => {
  it("includes parents iff a correlated child exists", async () => {
    const h = await IncrementalHarness.create(
      "SELECT c.id AS id FROM comments c WHERE EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id)",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", { id: 1 }),
      ins("comments", { id: 2 }),
      ins("replies", { id: 50, comment_id: 1 })
    ]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 1 })])
    );

    h.applyOps([ins("replies", { id: 51, comment_id: 2 })]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 1 }), JSONKey({ id: 2 })])
    );

    h.applyOps([del("replies", 50)]);
    expect(new Set(h.incremental().keys())).toEqual(
      new Set([JSONKey({ id: 2 })])
    );
    expectConsistent(h);
  });
});

describe("param arity", () => {
  it("rejects a referenced but unsupplied param, as Postgres does", async () => {
    await expect(
      compileShape(
        "SELECT id AS id FROM users WHERE id = $1 AND name = $2",
        [1]
      )
    ).rejects.toThrow(/references \$2 but received 1 parameter/);
  });

  it("rejects unreferenced params (extras and gaps)", async () => {
    await expect(
      compileShape("SELECT id AS id FROM users WHERE id = $1", [1, "junk"])
    ).rejects.toThrow(/parameter \$2 is never referenced/);
    await expect(
      compileShape("SELECT id AS id FROM users WHERE id = $1 AND name = $3", [
        1,
        "x",
        "y"
      ])
    ).rejects.toThrow(/parameter \$2 is never referenced/);
  });

  it("counts ANY-array, LIMIT/OFFSET, and subquery params as references", async () => {
    await expect(
      compileShape("SELECT id AS id FROM users WHERE id = ANY($1)", [])
    ).rejects.toThrow(/references \$1 but received 0 parameter/);
    await expect(
      compileShape(
        "SELECT id AS id FROM users WHERE id = $1 ORDER BY id LIMIT $2",
        [1]
      )
    ).rejects.toThrow(/references \$2 but received 1 parameter/);
    await expect(
      compileShape(
        "SELECT c.id AS id FROM comments c WHERE EXISTS " +
          "(SELECT 1 FROM replies r WHERE r.comment_id = c.id AND r.body = $1)",
        []
      )
    ).rejects.toThrow(/references \$1 but received 0 parameter/);
    await compileShape(
      "SELECT id AS id FROM users WHERE id = ANY($1) ORDER BY id LIMIT $2",
      [[1, 2], 5]
    );
  });
});

function JSONKey(picked: Record<string, unknown>): string {
  return keyOf(picked, Object.keys(picked));
}
function JSONVal(v: unknown): string {
  return stableStringify(v);
}
function expectConsistent(h: IncrementalHarness): void {
  const diff = mapsEqual(h.incremental(), h.recomputed());
  expect(diff, diff).toBeUndefined();
}

describe("value identity: hashing agrees with Postgres equality", () => {
  const types = {
    big: { id: "int8", n: "numeric" },
    small: { id: "int4", big_id: "int4", n: "numeric" }
  };
  const pk = { big: ["id"], small: ["id"] };
  const rows = [
    ins("big", { id: "5", n: "1.5" }),
    ins("small", { id: 1, big_id: 5, n: "1.50" }),
    ins("small", { id: 2, big_id: 6, n: "1.5" }),
    ins("small", { id: 3, big_id: 5, n: "2" })
  ];
  const run = async (sql: string) => {
    const h = await IncrementalHarness.create(
      sql,
      [],
      { columnTypes: types },
      pk
    );
    h.seed(rows);
    expectConsistent(h);
    return h;
  };

  it("joins int8 to int4 and numeric across scales", async () => {
    const byKey = await run(
      "SELECT b.id AS id, s.id AS sid FROM big b JOIN small s ON s.big_id = b.id"
    );
    expect(byKey.snapshotRows()).toEqual([
      { id: "5", sid: 1 },
      { id: "5", sid: 3 }
    ]);
    const byNum = await run(
      "SELECT b.id AS id, s.id AS sid FROM big b JOIN small s ON s.n = b.n"
    );
    expect(byNum.snapshotRows()).toEqual([
      { id: "5", sid: 1 },
      { id: "5", sid: 2 }
    ]);
  });

  it("groups, distincts and counts distinct by value, keeping the first spelling", async () => {
    const grouped = await run(
      "SELECT n, count(*) AS c FROM small GROUP BY n ORDER BY n"
    );
    expect(grouped.snapshotRows()).toEqual([
      { n: "1.50", c: "2" },
      { n: "2", c: "1" }
    ]);
    const distinct = await run("SELECT DISTINCT n FROM small ORDER BY n");
    expect(distinct.snapshotRows()).toEqual([{ n: "1.50" }, { n: "2" }]);
    const counted = await run("SELECT count(DISTINCT n) AS c FROM small");
    expect(counted.snapshotRows()).toEqual([{ c: "2" }]);
  });

  it("correlates EXISTS across spellings and survives retraction", async () => {
    const h = await run(
      "SELECT b.id AS id FROM big b WHERE EXISTS (SELECT 1 FROM small s WHERE s.n = b.n)"
    );
    expect(h.snapshotRows()).toEqual([{ id: "5" }]);
    h.applyOps([del("small", 1)]);
    expect(h.snapshotRows()).toEqual([{ id: "5" }]);
    h.applyOps([del("small", 2)]);
    expect(h.snapshotRows()).toEqual([]);
    expectConsistent(h);
  });
});
