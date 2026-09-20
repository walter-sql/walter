import { describe, expect, it } from "vitest";
import { parseShapeSql } from "../src/parser/parse";
import { shapeFingerprint } from "../src/planner/hash";
import { catalogOf, IncrementalHarness, TEST_TYPES } from "./support";
import { stableStringify } from "../src/ivm/zset";
import type { RowOp } from "./support";

const PK = { users: ["id"], comments: ["id"] };
const CATALOG = catalogOf({ columnTypes: TEST_TYPES, keyColumnsByTable: PK });

async function sameShape(starSql: string, explicitSql: string): Promise<void> {
  const star = await parseShapeSql(starSql, CATALOG);
  const explicit = await parseShapeSql(explicitSql, CATALOG);
  expect(shapeFingerprint(star, [])).toBe(shapeFingerprint(explicit, []));
}

const parse = (sql: string) => parseShapeSql(sql, CATALOG);

describe("select-list stars", () => {
  it("SELECT * expands to the catalog columns, in catalog order", async () => {
    await sameShape(
      "SELECT * FROM users",
      "SELECT users.id AS id, users.name AS name FROM users"
    );
  });

  it("t.* beside explicit columns", async () => {
    await sameShape(
      "SELECT u.*, c.body AS body FROM users u JOIN comments c ON c.user_id = u.id",
      "SELECT u.id AS id, u.name AS name, c.body AS body " +
        "FROM users u JOIN comments c ON c.user_id = u.id"
    );
  });

  it("bare * over a join with colliding column names rejects", async () => {
    await expect(
      parse("SELECT * FROM users u JOIN replies r ON r.id = u.id")
    ).rejects.toThrow(/duplicate output column "id"/);
  });

  it("* in EXISTS is expanded (the list is semantically void there)", async () => {
    const shape = await parse(
      "SELECT id FROM users u WHERE EXISTS (SELECT * FROM comments c WHERE c.user_id = u.id)"
    );
    expect(shape.query.where).toBeDefined();
  });

  it("unknown alias rejects", async () => {
    await expect(parse("SELECT x.* FROM users u")).rejects.toThrow(
      /unknown table alias/
    );
  });

  it("a star outside the select list rejects", async () => {
    await expect(
      parse("SELECT id FROM users u WHERE u.* = u.*")
    ).rejects.toThrow(/only supported in the select list/);
  });
});

describe("ORDER BY / GROUP BY target-list references", () => {
  it("ORDER BY <n> is the n-th select item", async () => {
    await sameShape(
      "SELECT name FROM users ORDER BY 1 DESC",
      "SELECT name FROM users ORDER BY name DESC"
    );
  });

  it("ordinals resolve against the expanded select list", async () => {
    await sameShape(
      "SELECT * FROM users ORDER BY 2",
      "SELECT users.id AS id, users.name AS name FROM users ORDER BY users.name"
    );
  });

  it("a standalone ORDER BY name prefers the output column", async () => {
    await sameShape(
      "SELECT id AS name FROM users ORDER BY name",
      "SELECT id AS name FROM users ORDER BY id"
    );
  });

  it("alias resolution follows expressions", async () => {
    await sameShape(
      "SELECT upper(name) AS n FROM users ORDER BY n",
      "SELECT upper(name) AS n FROM users ORDER BY upper(name)"
    );
  });

  it("GROUP BY <n> is the n-th select item", async () => {
    await sameShape(
      "SELECT lower(name) AS x, count(*) AS n FROM users GROUP BY 1",
      "SELECT lower(name) AS x, count(*) AS n FROM users GROUP BY lower(name)"
    );
  });

  it("GROUP BY names stay input columns (input beats output)", async () => {
    const shape = await parse(
      "SELECT lower(name) AS name, count(*) AS n FROM users GROUP BY name"
    );
    expect(shape.query.groupBy[0]).toMatchObject({
      kind: "column",
      name: "name"
    });
  });

  it("GROUP BY a select alias that is no input column is that item", async () => {
    await sameShape(
      "SELECT lower(name) AS x, count(*) AS n FROM users GROUP BY x",
      "SELECT lower(name) AS x, count(*) AS n FROM users GROUP BY lower(name)"
    );
    await expect(
      parse("SELECT count(*) AS n, id AS uid FROM users GROUP BY n")
    ).rejects.toThrow(/aggregate functions are not allowed in GROUP BY/);
  });

  it("ordinals do not resolve inside aggregate ORDER BY", async () => {
    const ordinal = await parse(
      "SELECT room_id AS room_id, json_agg(body ORDER BY 1) AS xs FROM comments GROUP BY room_id"
    );
    const column = await parse(
      "SELECT room_id AS room_id, json_agg(body ORDER BY body) AS xs FROM comments GROUP BY room_id"
    );
    expect(shapeFingerprint(ordinal, [])).not.toBe(
      shapeFingerprint(column, [])
    );
  });

  it("out-of-range and non-integer constants reject as in Postgres", async () => {
    await expect(parse("SELECT name FROM users ORDER BY 3")).rejects.toThrow(
      /ORDER BY position 3 is not in select list/
    );
    await expect(parse("SELECT name FROM users ORDER BY 'x'")).rejects.toThrow(
      /non-integer constant in ORDER BY/
    );
    await expect(
      parse("SELECT name, count(*) AS n FROM users GROUP BY 3")
    ).rejects.toThrow(/GROUP BY position 3 is not in select list/);
    await expect(
      parse("SELECT name, count(*) AS n FROM users GROUP BY 'x'")
    ).rejects.toThrow(/non-integer constant in GROUP BY/);
  });

  it("a GROUP BY ordinal landing on an aggregate rejects", async () => {
    await expect(
      parse("SELECT count(*) AS n, name FROM users GROUP BY 1")
    ).rejects.toThrow(/aggregate functions are not allowed in GROUP BY/);
  });
});

describe("canonical column qualification", () => {
  it("bare columns are stamped with their owning alias", async () => {
    const shape = await parse("SELECT name FROM users WHERE name = 'x'");
    expect(shape.query.select[0]!.expr).toMatchObject({
      kind: "column",
      table: "users",
      name: "name"
    });
    expect(shape.query.where).toMatchObject({
      left: { kind: "column", table: "users", name: "name" }
    });
  });

  it("bare and qualified spellings are the same shape", async () => {
    await sameShape(
      "SELECT name FROM users",
      "SELECT users.name AS name FROM users"
    );
  });

  it("qualified GROUP BY matches a bare select column", async () => {
    await sameShape(
      "SELECT name, count(*) AS n FROM users GROUP BY users.name",
      "SELECT users.name AS name, count(*) AS n FROM users GROUP BY name"
    );
  });

  it("ambiguous bare columns reject at parse, as in Postgres", async () => {
    await expect(
      parse("SELECT body FROM comments c JOIN replies r ON r.comment_id = c.id")
    ).rejects.toThrow(/column reference "body" is ambiguous/);
  });

  it("output aliases still beat input columns in ORDER BY", async () => {
    await sameShape(
      "SELECT lower(name) AS name FROM users ORDER BY name",
      "SELECT lower(name) AS name FROM users ORDER BY lower(name)"
    );
  });
});

describe("whole-row constructors", () => {
  const EXPLICIT_AGG =
    "SELECT u.id AS id, (SELECT json_agg(json_build_object('id', c.id, 'user_id', c.user_id, 'room_id', c.room_id, 'body', c.body, 'score', c.score)) " +
    "FROM comments c WHERE c.user_id = u.id) AS comments FROM users u";

  it("json_agg(c) is json_agg(json_build_object(<all columns>))", async () => {
    await sameShape(
      "SELECT u.id AS id, (SELECT json_agg(c) FROM comments c WHERE c.user_id = u.id) AS comments FROM users u",
      EXPLICIT_AGG
    );
  });

  it("json_agg(c.*) is the same whole-row reference", async () => {
    await sameShape(
      "SELECT u.id AS id, (SELECT json_agg(c.*) FROM comments c WHERE c.user_id = u.id) AS comments FROM users u",
      EXPLICIT_AGG
    );
  });

  it("to_jsonb(u) / row_to_json(u.*) build the row object", async () => {
    const explicit =
      "SELECT c.id AS id, json_build_object('id', u.id, 'name', u.name) AS author " +
      "FROM comments c JOIN users u ON u.id = c.user_id";
    await sameShape(
      "SELECT c.id AS id, to_jsonb(u) AS author FROM comments c JOIN users u ON u.id = c.user_id",
      explicit
    );
    await sameShape(
      "SELECT c.id AS id, row_to_json(u.*) AS author FROM comments c JOIN users u ON u.id = c.user_id",
      explicit
    );
  });

  it("a bare identifier shadowed by a column stays a column", async () => {
    const shape = await parseShapeSql(
      "SELECT body.id AS id, json_agg(body) AS bodies FROM comments body GROUP BY body.id",
      CATALOG
    );
    const agg = shape.query.select.find(s => s.alias === "bodies")!.expr;
    expect(agg.kind).toBe("jsonAgg");
    expect((agg as { arg: { kind: string } }).arg.kind).toBe("column");
  });
});

describe("expanded shapes run end-to-end", () => {
  const ins = (table: string, newRow: Record<string, unknown>): RowOp => ({
    table,
    kind: "insert",
    newRow
  });

  it("SELECT c.*, to_jsonb(u) maintains under churn like the explicit spelling", async () => {
    const h = await IncrementalHarness.create(
      "SELECT c.*, to_jsonb(u) AS author FROM comments c JOIN users u ON u.id = c.user_id",
      [],
      {},
      PK
    );
    h.seed([
      ins("users", { id: 1, name: "Ann" }),
      ins("comments", { id: 10, user_id: 1, room_id: 1, body: "hi", score: 0 })
    ]);
    const doc = (name: string) =>
      stableStringify({
        id: 10,
        user_id: 1,
        room_id: 1,
        body: "hi",
        score: 0,
        author: { id: 1, name }
      });
    expect([...h.incremental().values()]).toEqual([doc("Ann")]);

    h.applyOps([
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Anne" },
        oldRow: { id: 1, name: "Ann" }
      }
    ]);
    expect([...h.incremental().values()]).toEqual([doc("Anne")]);
  });
});
