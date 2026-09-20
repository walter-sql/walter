import { describe, expect, it } from "vitest";
import { parseShapeSql } from "../src/parser/parse";
import { shapeFingerprint } from "../src/planner/hash";
import { catalogOf, IncrementalHarness, mapsEqual } from "./support";
import type { RowOp } from "./support";

const PK = { comments: ["id"], replies: ["id"] };
const CATALOG = catalogOf({ keyColumnsByTable: PK });

async function sameShape(cteSql: string, plainSql: string): Promise<void> {
  const cte = await parseShapeSql(cteSql, CATALOG);
  const plain = await parseShapeSql(plainSql, CATALOG);
  expect(shapeFingerprint(cte, [])).toBe(shapeFingerprint(plain, []));
}

describe("single-use CTE inlining", () => {
  it("a CTE as a collection body inlines to the derived-table spelling", async () => {
    await sameShape(
      "WITH r AS (SELECT r0.id, r0.comment_id, r0.body FROM replies r0 WHERE r0.body <> '') " +
        "SELECT c.id AS id, (SELECT json_agg(json_build_object('id', r2.id, 'body', r2.body)) " +
        "FROM r r2 WHERE r2.comment_id = c.id) AS replies FROM comments c",
      "SELECT c.id AS id, (SELECT json_agg(json_build_object('id', r2.id, 'body', r2.body)) " +
        "FROM (SELECT r0.id, r0.comment_id, r0.body FROM replies r0 WHERE r0.body <> '') r2 " +
        "WHERE r2.comment_id = c.id) AS replies FROM comments c"
    );
  });

  it("a CTE chain inlines transitively (b reads a, main reads b)", async () => {
    await sameShape(
      "WITH a AS (SELECT r0.id, r0.body FROM replies r0), " +
        "b AS (SELECT a.id FROM a WHERE a.body <> '') " +
        "SELECT x.id AS id FROM b x",
      "SELECT x.id AS id FROM " +
        "(SELECT a.id FROM (SELECT r0.id, r0.body FROM replies r0) a " +
        "WHERE a.body <> '') x"
    );
  });

  it("an unreferenced CTE is dropped", async () => {
    await sameShape(
      "WITH unused AS (SELECT id FROM replies) SELECT id FROM comments",
      "SELECT id FROM comments"
    );
  });

  it("a CTE referenced twice rejects", async () => {
    await expect(
      parseShapeSql(
        "WITH r AS (SELECT id, comment_id FROM replies) " +
          "SELECT a.id AS id, b.id AS bid FROM r a JOIN r b ON b.comment_id = a.id",
        CATALOG
      )
    ).rejects.toThrow(/referenced 2 times/);
  });

  it("WITH RECURSIVE rejects", async () => {
    await expect(
      parseShapeSql(
        "WITH RECURSIVE t AS (SELECT id FROM comments UNION ALL SELECT id + 1 FROM t) " +
          "SELECT id FROM t",
        CATALOG
      )
    ).rejects.toThrow(/WITH RECURSIVE/);
  });

  it("CTE column aliases reject", async () => {
    await expect(
      parseShapeSql(
        "WITH r(rid) AS (SELECT id FROM replies) SELECT rid AS rid FROM r",
        CATALOG
      )
    ).rejects.toThrow(/CTE column aliases/);
  });

  it("a qualified name is never mistaken for the CTE", async () => {
    const shape = await parseShapeSql(
      "WITH r AS (SELECT id FROM comments) SELECT x.id AS id FROM public.r x",
      CATALOG
    );
    expect(shape.query.from).toMatchObject({
      kind: "table",
      name: "r",
      schema: "public"
    });
  });

  it("maintains a CTE-spelled collection under churn", async () => {
    const ins = (table: string, newRow: Record<string, unknown>): RowOp => ({
      table,
      kind: "insert",
      newRow
    });
    const h = await IncrementalHarness.create(
      "WITH r AS (SELECT r0.id, r0.comment_id, r0.body FROM replies r0 WHERE r0.body <> '') " +
        "SELECT c.id AS id, (SELECT json_agg(json_build_object('id', r2.id, 'body', r2.body) ORDER BY r2.id) " +
        "FROM r r2 WHERE r2.comment_id = c.id) AS replies FROM comments c",
      [],
      {},
      PK
    );
    h.seed([
      ins("comments", {
        id: 1,
        user_id: 1,
        room_id: 1,
        body: "post",
        score: 0
      }),
      ins("replies", { id: 10, comment_id: 1, body: "yes" }),
      ins("replies", { id: 11, comment_id: 1, body: "" })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 1, replies: [{ id: 10, body: "yes" }] }
    ]);

    h.applyOps([
      {
        table: "replies",
        kind: "update",
        newRow: { id: 11, comment_id: 1, body: "now visible" },
        oldRow: { id: 11, comment_id: 1, body: "" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 1,
        replies: [
          { id: 10, body: "yes" },
          { id: 11, body: "now visible" }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});
