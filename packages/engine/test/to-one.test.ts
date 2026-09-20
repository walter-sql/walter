import { describe, it, expect } from "vitest";
import { IncrementalHarness, compileShape, mapsEqual } from "./support";
import { applyView, pendingView } from "@walter-sql/view";
import type { RowOp } from "./support";
import type { CollectionOp } from "@walter-sql/view";
import type { Row } from "../src/ivm/zset";

const SQL = `
  SELECT c.id AS id, c.user_id AS user_id,
         json_build_object('id', u.id, 'name', u.name) AS author
  FROM comments c LEFT JOIN users u ON u.id = c.user_id
`;
const PK = { comments: ["id"], users: ["id"] };

const ins = (table: string, newRow: Row): RowOp => ({
  table,
  kind: "insert",
  newRow
});
const comment = (id: number, userId: number): Row => ({
  id,
  user_id: userId,
  room_id: 1,
  body: "hi",
  score: 0
});

describe("to-one nested object", () => {
  it("renders an object and patches one field granularly", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1))
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, user_id: 1, author: { id: 1, name: "Alice" } }
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [{ op: "set", field: "name", value: "Alicia" }]
          }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 10, user_id: 1, author: { id: 1, name: "Alicia" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("is null with no match, and set when the row appears", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([ins("comments", comment(10, 1))]);
    expect(h.snapshotRows()).toEqual([{ id: 10, user_id: 1, author: null }]);

    const changes = h.applyOps([ins("users", { id: 1, name: "Alice" })]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [{ op: "set", field: "author", value: { id: 1, name: "Alice" } }]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("patches one shared to-one across every parent that references it", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1)),
      ins("comments", comment(11, 1))
    ]);

    const changes = h.applyOps([
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    const patch = [
      {
        op: "patch",
        field: "author",
        ops: [{ op: "set", field: "name", value: "Alicia" }]
      }
    ];
    const updates = changes as Extract<CollectionOp, { op: "update" }>[];
    expect([...updates].sort((a, b) => a.index - b.index)).toEqual([
      { op: "update", index: 0, ops: patch },
      { op: "update", index: 1, ops: patch }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("goes back to null when the to-one row is deleted", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1))
    ]);

    const changes = h.applyOps([
      { table: "users", kind: "delete", oldRow: { id: 1 } }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [{ op: "set", field: "author", value: null }]
      }
    ]);
    expect(h.snapshotRows()).toEqual([{ id: 10, user_id: 1, author: null }]);
  });

  it("patches a to-one and a sibling collection independently", async () => {
    const sql = `
      SELECT c.id AS id, c.user_id AS user_id,
        json_build_object('id', u.id, 'name', u.name) AS author,
        (SELECT json_agg(json_build_object('id', r.id, 'body', r.body))
         FROM replies r WHERE r.comment_id = c.id) AS replies
      FROM comments c LEFT JOIN users u ON u.id = c.user_id`;
    const pk = { comments: ["id"], users: ["id"], replies: ["id"] };
    const h = await IncrementalHarness.create(sql, [], {}, pk);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1)),
      ins("replies", { id: 100, comment_id: 10, body: "yo" })
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 10,
        user_id: 1,
        author: { id: 1, name: "Alice" },
        replies: [{ id: 100, body: "yo" }]
      }
    ]);

    const authorEdit = h.applyOps([
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    expect(authorEdit).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [{ op: "set", field: "name", value: "Alicia" }]
          }
        ]
      }
    ]);

    const replyAdd = h.applyOps([
      ins("replies", { id: 101, comment_id: 10, body: "hey" })
    ]);
    expect(replyAdd).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "nest",
            field: "replies",
            ops: [{ op: "add", value: { id: 101, body: "hey" } }]
          }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("peels only when the correlation is the child PK and the FK is projected", async () => {
    const pkJoin = await compileShape(SQL, [], { keyColumnsByTable: PK });
    expect(pkJoin.shape.root.collections).toHaveLength(1);
    expect(pkJoin.shape.root.collections[0]!.single).toBe(true);

    const nonPk = await compileShape(
      `SELECT c.id AS id, json_build_object('name', u.name) AS author
       FROM comments c LEFT JOIN users u ON u.name = c.body`,
      [],
      { keyColumnsByTable: PK }
    );
    expect(nonPk.shape.root.collections).toHaveLength(0);

    const noFk = await compileShape(
      `SELECT c.id AS id, json_build_object('id', u.id, 'name', u.name) AS author
       FROM comments c LEFT JOIN users u ON u.id = c.user_id`,
      [],
      { keyColumnsByTable: PK }
    );
    expect(noFk.shape.root.collections).toHaveLength(0);
  });

  it("reships the object when a mutable FK repoints to another child", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("users", { id: 2, name: "Bob" }),
      ins("comments", comment(10, 1))
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "comments",
        kind: "update",
        newRow: { ...comment(10, 1), user_id: 2 },
        oldRow: { id: 10 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          { op: "set", field: "user_id", value: 2 },
          { op: "set", field: "author", value: { id: 2, name: "Bob" } }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 10, user_id: 2, author: { id: 2, name: "Bob" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("repoints a mutable FK to a non-existent row -> object becomes null", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1))
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "comments",
        kind: "update",
        newRow: { ...comment(10, 1), user_id: 99 },
        oldRow: { id: 10 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          { op: "set", field: "user_id", value: 99 },
          { op: "set", field: "author", value: null }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([{ id: 10, user_id: 99, author: null }]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("nests to-one across three levels (depth 3) and patches the deepest field", async () => {
    const types = {
      comments: { id: "int4", user_id: "int4", body: "text" },
      users: { id: "int4", name: "text", org_id: "int4" },
      organizations: { id: "int4", title: "text", country_id: "int4" },
      countries: { id: "int4", name: "text" }
    };
    const pk = {
      comments: ["id"],
      users: ["id"],
      organizations: ["id"],
      countries: ["id"]
    };
    const sql = `
      SELECT c.id AS id, c.user_id AS user_id,
        (SELECT json_build_object('id', u.id, 'name', u.name, 'org_id', u.org_id,
           'org', (SELECT json_build_object('id', o.id, 'title', o.title, 'country_id', o.country_id,
              'country', (SELECT json_build_object('id', n.id, 'name', n.name)
                          FROM countries n WHERE n.id = o.country_id))
                   FROM organizations o WHERE o.id = u.org_id))
         FROM users u WHERE u.id = c.user_id) AS author
      FROM comments c`;

    const h = await IncrementalHarness.create(
      sql,
      [],
      { columnTypes: types },
      pk
    );
    h.seed([
      ins("countries", { id: 3, name: "France" }),
      ins("organizations", { id: 7, title: "Acme", country_id: 3 }),
      ins("users", { id: 1, name: "Alice", org_id: 7 }),
      ins("comments", { id: 10, user_id: 1, body: "hi" })
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 10,
        user_id: 1,
        author: {
          id: 1,
          name: "Alice",
          org_id: 7,
          org: {
            id: 7,
            title: "Acme",
            country_id: 3,
            country: { id: 3, name: "France" }
          }
        }
      }
    ]);

    const changes = h.applyOps([
      {
        table: "countries",
        kind: "update",
        newRow: { id: 3, name: "Frankreich" },
        oldRow: { id: 3 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [
              {
                op: "patch",
                field: "org",
                ops: [
                  {
                    op: "patch",
                    field: "country",
                    ops: [{ op: "set", field: "name", value: "Frankreich" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("removes a sibling and patches the survivor's shared author in one batch", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1)),
      ins("comments", comment(11, 1))
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      { table: "comments", kind: "delete", oldRow: { id: 10 } },
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    expect(changes).toEqual([
      { op: "remove", index: 0 },
      {
        op: "update",
        index: 1,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [{ op: "set", field: "name", value: "Alicia" }]
          }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 11, user_id: 1, author: { id: 1, name: "Alicia" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("adds a parent (ships its author whole) while patching the existing sibling", async () => {
    const h = await IncrementalHarness.create(SQL, [], {}, PK);
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("comments", comment(10, 1))
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      ins("comments", comment(11, 1)),
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "add",
        value: { id: 11, user_id: 1, author: { id: 1, name: "Alicia" } }
      },
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [{ op: "set", field: "name", value: "Alicia" }]
          }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 10, user_id: 1, author: { id: 1, name: "Alicia" } },
      { id: 11, user_id: 1, author: { id: 1, name: "Alicia" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("absorbs a deep author edit when the owning chat is deleted in the same batch", async () => {
    const types = {
      projects: { id: "int4", name: "text" },
      chats: { id: "int4", project_id: "int4", title: "text", user_id: "int4" },
      users: { id: "int4", name: "text" }
    };
    const pk = { projects: ["id"], chats: ["id"], users: ["id"] };
    const sql = `
      SELECT p.id AS id, p.name AS name,
        (SELECT json_agg(json_build_object(
           'id', c.id, 'title', c.title, 'user_id', c.user_id,
           'author', (SELECT json_build_object('id', u.id, 'name', u.name)
                      FROM users u WHERE u.id = c.user_id)))
         FROM chats c WHERE c.project_id = p.id) AS chats
      FROM projects p`;
    const h = await IncrementalHarness.create(
      sql,
      [],
      { columnTypes: types },
      pk
    );
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("users", { id: 2, name: "Bob" }),
      ins("projects", { id: 1, name: "P" }),
      ins("chats", { id: 10, project_id: 1, title: "t10", user_id: 1 }),
      ins("chats", { id: 11, project_id: 1, title: "t11", user_id: 2 })
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      },
      { table: "chats", kind: "delete", oldRow: { id: 10 } }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [{ op: "nest", field: "chats", ops: [{ op: "remove", index: 0 }] }]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      {
        id: 1,
        name: "P",
        chats: [
          { id: 11, title: "t11", user_id: 2, author: { id: 2, name: "Bob" } }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("composes a chat's scalar edit and its author patch into one nested update", async () => {
    const types = {
      projects: { id: "int4", name: "text" },
      chats: { id: "int4", project_id: "int4", title: "text", user_id: "int4" },
      users: { id: "int4", name: "text" }
    };
    const pk = { projects: ["id"], chats: ["id"], users: ["id"] };
    const sql = `
      SELECT p.id AS id, p.name AS name,
        (SELECT json_agg(json_build_object(
           'id', c.id, 'title', c.title, 'user_id', c.user_id,
           'author', (SELECT json_build_object('id', u.id, 'name', u.name)
                      FROM users u WHERE u.id = c.user_id)))
         FROM chats c WHERE c.project_id = p.id) AS chats
      FROM projects p`;
    const h = await IncrementalHarness.create(
      sql,
      [],
      { columnTypes: types },
      pk
    );
    h.seed([
      ins("users", { id: 1, name: "Alice" }),
      ins("projects", { id: 1, name: "P" }),
      ins("chats", { id: 10, project_id: 1, title: "t10", user_id: 1 })
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "chats",
        kind: "update",
        newRow: { id: 10, project_id: 1, title: "t10b", user_id: 1 },
        oldRow: { id: 10 }
      },
      {
        table: "users",
        kind: "update",
        newRow: { id: 1, name: "Alicia" },
        oldRow: { id: 1 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "nest",
            field: "chats",
            ops: [
              {
                op: "update",
                index: 0,
                ops: [
                  { op: "set", field: "title", value: "t10b" },
                  {
                    op: "patch",
                    field: "author",
                    ops: [{ op: "set", field: "name", value: "Alicia" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      {
        id: 1,
        name: "P",
        chats: [
          {
            id: 10,
            title: "t10b",
            user_id: 1,
            author: { id: 1, name: "Alicia" }
          }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("nests to-one within to-one (depth 2) and patches the deepest field", async () => {
    const types = {
      comments: { id: "int4", user_id: "int4", body: "text" },
      users: { id: "int4", name: "text", org_id: "int4" },
      organizations: { id: "int4", title: "text" }
    };
    const pk = { comments: ["id"], users: ["id"], organizations: ["id"] };
    const sql = `
      SELECT c.id AS id, c.user_id AS user_id,
        (SELECT json_build_object('id', u.id, 'name', u.name, 'org_id', u.org_id,
           'org', (SELECT json_build_object('id', o.id, 'title', o.title)
                   FROM organizations o WHERE o.id = u.org_id))
         FROM users u WHERE u.id = c.user_id) AS author
      FROM comments c`;

    const compiled = await compileShape(sql, [], {
      columnTypes: types,
      keyColumnsByTable: pk
    });
    const author = compiled.shape.root.collections[0]!;
    expect(author.single).toBe(true);
    expect(author.level.collections[0]!.single).toBe(true);

    const h = await IncrementalHarness.create(
      sql,
      [],
      { columnTypes: types },
      pk
    );
    h.seed([
      ins("organizations", { id: 7, title: "Acme" }),
      ins("users", { id: 1, name: "Alice", org_id: 7 }),
      ins("comments", { id: 10, user_id: 1, body: "hi" })
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 10,
        user_id: 1,
        author: {
          id: 1,
          name: "Alice",
          org_id: 7,
          org: { id: 7, title: "Acme" }
        }
      }
    ]);

    const changes = h.applyOps([
      {
        table: "organizations",
        kind: "update",
        newRow: { id: 7, title: "Acme Inc" },
        oldRow: { id: 7 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "author",
            ops: [
              {
                op: "patch",
                field: "org",
                ops: [{ op: "set", field: "title", value: "Acme Inc" }]
              }
            ]
          }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});

describe("to-one by latest (FK-correlated, LIMIT 1)", () => {
  const TYPES = {
    projects: { id: "int4", name: "text" },
    chats: { id: "int4", project_id: "int4", title: "text", created_at: "int4" }
  };
  const PK = { projects: ["id"], chats: ["id"] };
  const LATEST = `
    SELECT p.id AS id, p.name AS name,
      (SELECT json_build_object('id', c.id, 'title', c.title)
       FROM chats c WHERE c.project_id = p.id
       ORDER BY c.created_at DESC LIMIT 1) AS latest_chat
    FROM projects p`;
  const chat = (id: number, createdAt: number): Row => ({
    id,
    project_id: 1,
    title: `t${id}`,
    created_at: createdAt
  });

  it("peels into a single edge proven ≤1 by LIMIT 1, not by PK correlation", async () => {
    const { shape } = await compileShape(LATEST, [], {
      columnTypes: TYPES,
      keyColumnsByTable: PK
    });
    const edge = shape.root.collections[0]!;
    expect(edge.single).toBe(true);
    expect(edge.level.correlationSource!.columns).toEqual(["project_id"]);
    expect(edge.level.dataflow).toBeDefined();
  });

  it("rejects an object subquery that is neither PK-correlated nor LIMIT 1", async () => {
    await expect(
      compileShape(
        `SELECT p.id AS id,
           (SELECT json_build_object('id', c.id, 'title', c.title)
            FROM chats c WHERE c.project_id = p.id) AS latest_chat
         FROM projects p`,
        [],
        { columnTypes: TYPES, keyColumnsByTable: PK }
      )
    ).rejects.toThrow(/≤1 per parent/);
  });

  it("renders the latest chat as the object and reships it when a newer one arrives", async () => {
    const h = await IncrementalHarness.create(
      LATEST,
      [],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("projects", { id: 1, name: "P" }),
      ins("chats", chat(10, 100)),
      ins("chats", chat(11, 200))
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 1, name: "P", latest_chat: { id: 11, title: "t11" } }
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([ins("chats", chat(12, 300))]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          { op: "set", field: "latest_chat", value: { id: 12, title: "t12" } }
        ]
      }
    ]);
    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 1, name: "P", latest_chat: { id: 12, title: "t12" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("falls back to the previous latest when the current one is deleted", async () => {
    const h = await IncrementalHarness.create(
      LATEST,
      [],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("projects", { id: 1, name: "P" }),
      ins("chats", chat(10, 100)),
      ins("chats", chat(11, 200))
    ]);

    const changes = h.applyOps([
      { table: "chats", kind: "delete", oldRow: { id: 11 } }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          { op: "set", field: "latest_chat", value: { id: 10, title: "t10" } }
        ]
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 1, name: "P", latest_chat: { id: 10, title: "t10" } }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("patches a field of the latest chat in place", async () => {
    const h = await IncrementalHarness.create(
      LATEST,
      [],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("projects", { id: 1, name: "P" }),
      ins("chats", chat(10, 100)),
      ins("chats", chat(11, 200))
    ]);

    const changes = h.applyOps([
      {
        table: "chats",
        kind: "update",
        newRow: { ...chat(11, 200), title: "t11b" },
        oldRow: { id: 11 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "patch",
            field: "latest_chat",
            ops: [{ op: "set", field: "title", value: "t11b" }]
          }
        ]
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});

describe("to-one by unique key (non-PK correlation)", () => {
  const TYPES = {
    accounts: { id: "int4", email: "text", name: "text" },
    posts: { id: "int4", author_email: "text", body: "text" }
  };
  const PK = { accounts: ["id"], posts: ["id"] };
  const OPTS = {
    columnTypes: TYPES,
    uniqueKeysByTable: { accounts: [["email"]] }
  };
  const SQL = `
    SELECT p.id AS id, p.author_email AS author_email,
      (SELECT json_build_object('id', a.id, 'name', a.name)
       FROM accounts a WHERE a.email = p.author_email) AS author
    FROM posts p`;

  it("compiles as single with the unique key; rejects without it", async () => {
    const { shape } = await compileShape(SQL, [], {
      ...OPTS,
      keyColumnsByTable: PK
    });
    const edge = shape.root.collections[0]!;
    expect(edge.single).toBe(true);
    expect(edge.level.correlationSource!.columns).toEqual(["email"]);

    await expect(
      compileShape(SQL, [], { columnTypes: TYPES, keyColumnsByTable: PK })
    ).rejects.toThrow(/≤1 per parent/);
  });

  it("maintains the object under churn", async () => {
    const h = await IncrementalHarness.create(SQL, [], OPTS, PK);
    h.seed([
      ins("accounts", { id: 1, email: "a@x", name: "Ann" }),
      ins("posts", { id: 10, author_email: "a@x", body: "hi" })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_email: "a@x", author: { id: 1, name: "Ann" } }
    ]);

    h.applyOps([
      {
        table: "accounts",
        kind: "update",
        newRow: { id: 1, email: "a@x", name: "Anne" },
        oldRow: { id: 1, email: "a@x", name: "Ann" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_email: "a@x", author: { id: 1, name: "Anne" } }
    ]);

    h.applyOps([
      {
        table: "accounts",
        kind: "delete",
        oldRow: { id: 1, email: "a@x", name: "Anne" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_email: "a@x", author: null }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});

describe("to-one over-correlated beyond the unique key", () => {
  const TYPES = {
    accounts: { id: "int4", email: "text", name: "text" },
    posts: {
      id: "int4",
      author_id: "int4",
      author_email: "text",
      body: "text"
    }
  };
  const PK = { accounts: ["id"], posts: ["id"] };
  const OPTS = { columnTypes: TYPES };
  const SQL = `
    SELECT p.id AS id, p.author_id AS author_id, p.author_email AS author_email,
      (SELECT json_build_object('id', a.id, 'name', a.name)
       FROM accounts a
       WHERE a.id = p.author_id AND a.email = p.author_email) AS author
    FROM posts p`;

  it("compiles as single: the PK is pinned, the extra conjunct filters", async () => {
    const { shape } = await compileShape(SQL, [], {
      ...OPTS,
      keyColumnsByTable: PK
    });
    const edge = shape.root.collections[0]!;
    expect(edge.single).toBe(true);
    expect([...edge.level.correlationSource!.columns].sort()).toEqual([
      "email",
      "id"
    ]);
  });

  it("applies the extra conjunct under churn (filters, never fans out)", async () => {
    const h = await IncrementalHarness.create(SQL, [], OPTS, PK);
    h.seed([
      ins("accounts", { id: 1, email: "a@x", name: "Ann" }),
      ins("posts", { id: 10, author_id: 1, author_email: "a@x", body: "hi" })
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 10,
        author_id: 1,
        author_email: "a@x",
        author: { id: 1, name: "Ann" }
      }
    ]);

    h.applyOps([
      {
        table: "accounts",
        kind: "update",
        newRow: { id: 1, email: "b@x", name: "Ann" },
        oldRow: { id: 1, email: "a@x", name: "Ann" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_id: 1, author_email: "a@x", author: null }
    ]);

    h.applyOps([
      {
        table: "accounts",
        kind: "update",
        newRow: { id: 1, email: "a@x", name: "Anne" },
        oldRow: { id: 1, email: "b@x", name: "Ann" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      {
        id: 10,
        author_id: 1,
        author_email: "a@x",
        author: { id: 1, name: "Anne" }
      }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});

describe("inline object lifted by unique key (non-PK correlation)", () => {
  const TYPES = {
    accounts: { id: "int4", email: "text", name: "text" },
    posts: { id: "int4", author_email: "text", body: "text" }
  };
  const PK = { accounts: ["id"], posts: ["id"] };
  const OPTS = {
    columnTypes: TYPES,
    uniqueKeysByTable: { accounts: [["email"]] }
  };
  const SQL = `
    SELECT p.id AS id, p.author_email AS author_email,
           json_build_object('id', a.id, 'name', a.name) AS author
    FROM posts p LEFT JOIN accounts a ON a.email = p.author_email`;

  it("lifts with the witness; stays a flat scalar without it", async () => {
    const { shape } = await compileShape(SQL, [], {
      ...OPTS,
      keyColumnsByTable: PK
    });
    expect(shape.root.collections).toHaveLength(1);
    const edge = shape.root.collections[0]!;
    expect(edge.single).toBe(true);
    expect(edge.level.correlationSource!.columns).toEqual(["email"]);

    const flat = await compileShape(SQL, [], {
      columnTypes: TYPES,
      keyColumnsByTable: PK
    });
    expect(flat.shape.root.collections).toHaveLength(0);
  });

  it("maintains the lifted object under churn", async () => {
    const h = await IncrementalHarness.create(SQL, [], OPTS, PK);
    h.seed([
      ins("accounts", { id: 1, email: "a@x", name: "Ann" }),
      ins("posts", { id: 10, author_email: "a@x", body: "hi" })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_email: "a@x", author: { id: 1, name: "Ann" } }
    ]);

    h.applyOps([
      {
        table: "accounts",
        kind: "update",
        newRow: { id: 1, email: "b@x", name: "Ann" },
        oldRow: { id: 1, email: "a@x", name: "Ann" }
      }
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, author_email: "a@x", author: null }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});
