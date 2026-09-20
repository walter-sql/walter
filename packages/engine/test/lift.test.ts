import { describe, it, expect } from "vitest";
import { parseShapeSql } from "../src/parser/parse";
import { collectTables } from "../src/parser/ir";
import type { CollectionSpec, Query, ShapeQuery } from "../src/parser/ir";
import { shapeFingerprint } from "../src/planner/hash";
import { catalogOf } from "./support";

const allTableNames = (shape: ShapeQuery): string[] => {
  const names = collectTables(shape.query.from).map(t => t.name);
  for (const c of shape.collections) names.push(...allTableNames(c.node));
  return names;
};

const NO_CATALOG = catalogOf({});

const onlyChild = (
  sql: string,
  defaultSchema?: string,
  pkByTable?: Record<string, string[]>
): Promise<CollectionSpec> =>
  parseShapeSql(
    sql,
    catalogOf({ keyColumnsByTable: pkByTable }),
    defaultSchema
  ).then(shape => {
    expect(shape.collections).toHaveLength(1);
    return shape.collections[0]!;
  });

describe("lift: collection spellings lower to one tree", () => {
  it("inline GROUP BY json_agg", async () => {
    const c = await onlyChild(
      "SELECT c.id AS id, c.body AS body, " +
        "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
        "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id GROUP BY c.id"
    );
    expect(c.field).toBe("replies");
    expect(c.parentKey).toEqual(["id"]);
    expect(c.childKey).toEqual(["__corr_0"]);
    expect(c.node.query.limit).toBeUndefined();
    expect(c.node.query.select.map(s => s.alias)).toEqual([
      "id",
      "body",
      "__corr_0"
    ]);
  });

  it("lateral subquery with per-child LIMIT", async () => {
    const c = await onlyChild(
      "SELECT c.id AS id, c.body AS body, sub.replies AS replies " +
        "FROM comments c LEFT JOIN LATERAL (" +
        "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id DESC), '[]') AS replies" +
        "  FROM (SELECT r.id, r.body, r.comment_id FROM replies r WHERE r.comment_id = c.id ORDER BY r.id DESC LIMIT 3) r" +
        ") sub ON true"
    );
    expect(c.field).toBe("replies");
    expect(c.parentKey).toEqual(["id"]);
    expect(c.childKey).toEqual(["__corr_0"]);
    expect(c.node.query.limit).toBe(3);
    expect(c.node.query.orderBy).toHaveLength(1);
    expect(c.node.query.orderBy[0]!.desc).toBe(true);
    expect(c.node.query.from).toMatchObject({ kind: "table", name: "replies" });
  });

  it("scalar subquery with per-child LIMIT", async () => {
    const c = await onlyChild(
      "SELECT c.id AS id, (" +
        "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id DESC), '[]')" +
        "  FROM (SELECT r.id, r.body, r.comment_id FROM replies r WHERE r.comment_id = c.id ORDER BY r.id DESC LIMIT 3) r" +
        ") AS replies FROM comments c"
    );
    expect(c.field).toBe("replies");
    expect(c.parentKey).toEqual(["id"]);
    expect(c.node.query.limit).toBe(3);
  });

  it("residual root is flat (lift fully consumes the subquery)", async () => {
    const shape = await parseShapeSql(
      "SELECT c.id AS id, sub.replies AS replies " +
        "FROM comments c LEFT JOIN LATERAL (" +
        "  SELECT coalesce(json_agg(json_build_object('id', r.id) ORDER BY r.id), '[]') AS replies" +
        "  FROM replies r WHERE r.comment_id = c.id" +
        ") sub ON true",
      NO_CATALOG
    );
    const noSubquery = (q: Query): void => {
      expect(q.from.kind).not.toBe("subquery");
      for (const s of q.select) expect(s.expr.kind).not.toBe("scalarSubquery");
    };
    noSubquery(shape.query);
    expect(shape.query.select.map(s => s.alias)).toEqual(["id"]);
  });

  it("a child alias used outside json_agg never double-qualifies", async () => {
    const shape = await parseShapeSql(
      "SELECT p.id AS id, p.created_at AS createdAt, " +
        "coalesce(json_agg(json_build_object('id', c.id, 'projectId', c.project_id) ORDER BY c.updated_at DESC) FILTER (WHERE c.id IS NOT NULL), '[]') AS chats " +
        "FROM projects p LEFT JOIN chats c ON c.project_id = p.id " +
        "WHERE p.workspace_id = $1 " +
        "GROUP BY p.id, p.created_at " +
        "ORDER BY coalesce(max(c.updated_at), p.created_at) DESC",
      NO_CATALOG,
      "public"
    );
    const names = allTableNames(shape);
    expect(names).not.toContain("public.public.chats");
    for (const n of names) expect(n.startsWith("public.")).toBe(true);
    expect([...names].sort()).toEqual([
      "public.chats",
      "public.chats",
      "public.projects"
    ]);
  });

  it("collection over a junction join stays a join child level", async () => {
    const c = await onlyChild(
      "SELECT n.id AS id, (" +
        "  SELECT coalesce(json_agg(json_build_object('id', pa.id, 'name', pa.name) ORDER BY pa.created_at), '[]')" +
        "  FROM node_parameters np JOIN parameters pa ON pa.id = np.parameter_id" +
        "  WHERE np.node_id = n.id" +
        ") AS parameters FROM nodes n"
    );
    expect(c.field).toBe("parameters");
    expect(c.parentKey).toEqual(["id"]);
    expect(c.childKey).toEqual(["__corr_0"]);
    expect(c.node.query.from.kind).toBe("join");
    expect([...allTableNames(c.node)].sort()).toEqual([
      "node_parameters",
      "parameters"
    ]);
  });

  it("a to-one join inside a collection peels into a nested to-one level", async () => {
    const c = await onlyChild(
      "SELECT p.id AS id, (" +
        "  SELECT coalesce(json_agg(json_build_object(" +
        "    'id', c.id," +
        "    'upstreamParamId', c.upstream_param_id," +
        "    'upstreamParam', json_build_object('id', up.id, 'name', up.name)" +
        "  ) ORDER BY c.created_at), '[]')" +
        "  FROM contradictions c JOIN parameters up ON up.id = c.upstream_param_id" +
        "  WHERE c.project_id = p.id" +
        ") AS contradictions FROM projects p",
      undefined,
      { parameters: ["id"] }
    );
    expect(c.field).toBe("contradictions");
    expect(c.node.query.from).toMatchObject({
      kind: "table",
      name: "contradictions"
    });
    expect(c.node.collections).toHaveLength(1);
    const up = c.node.collections[0]!;
    expect(up.field).toBe("upstreamParam");
    expect(up.object).toBe(true);
    expect(up.parentKey).toEqual(["upstreamParamId"]);
  });

  it("array_agg / jsonb_agg over json_build_object are json_agg spellings", async () => {
    const spelled = (agg: string) =>
      parseShapeSql(
        `SELECT c.id AS id, (SELECT ${agg}(json_build_object('id', r.id) ORDER BY r.id) ` +
          "FROM replies r WHERE r.comment_id = c.id) AS replies FROM comments c",
        NO_CATALOG
      ).then(s => shapeFingerprint(s, []));
    const canonical = await spelled("json_agg");
    expect(await spelled("jsonb_agg")).toBe(canonical);
    expect(await spelled("array_agg")).toBe(canonical);
  });

  it("array_agg over a non-object argument rejects", async () => {
    await expect(
      parseShapeSql(
        "SELECT c.id AS id, array_agg(r.body) AS bodies " +
          "FROM comments c JOIN replies r ON r.comment_id = c.id GROUP BY c.id",
        NO_CATALOG
      )
    ).rejects.toThrow(/array_agg is supported only over json_build_object/);
  });

  it("json_agg(DISTINCT ...) rejects", async () => {
    await expect(
      parseShapeSql(
        "SELECT c.id AS id, json_agg(DISTINCT json_build_object('id', r.id)) AS replies " +
          "FROM comments c JOIN replies r ON r.comment_id = c.id GROUP BY c.id",
        NO_CATALOG
      )
    ).rejects.toThrow(/DISTINCT .* is not supported/);
  });

  it("depth ≥ 2: nested scalar subquery lowers to a grandchild level", async () => {
    const c = await onlyChild(
      "SELECT c.id AS id, (" +
        "  SELECT coalesce(json_agg(json_build_object(" +
        "    'id', r.id," +
        "    'tags', (SELECT coalesce(json_agg(json_build_object('id', t.id)), '[]') FROM tags t WHERE t.reply_id = r.id)" +
        "  ) ORDER BY r.id), '[]')" +
        "  FROM replies r WHERE r.comment_id = c.id" +
        ") AS replies FROM comments c"
    );
    expect(c.field).toBe("replies");
    expect(c.node.collections).toHaveLength(1);
    expect(c.node.collections[0]!.field).toBe("tags");
    expect(c.node.collections[0]!.parentKey).toEqual(["id"]);
  });
});
