import { describe, it, expect } from "vitest";
import { IncrementalHarness, Rng, mapsEqual } from "./support";
import type { RowOp } from "./support";

const PK = { users: ["id"], comments: ["id"], replies: ["id"] };

interface Template {
  name: string;
  sql: string;
  params: unknown[];
  tables: ("users" | "comments" | "replies")[];
}

const TEMPLATES: Template[] = [
  {
    name: "filter+project",
    sql: "SELECT id, body, score FROM comments WHERE room_id = $1 AND score >= $2",
    params: [1, 3],
    tables: ["comments"]
  },
  {
    name: "inner join",
    sql: "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.room_id = $1",
    params: [1],
    tables: ["users", "comments"]
  },
  {
    name: "left join nesting",
    sql:
      "SELECT c.id AS id, c.body AS body, " +
      "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
      "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id GROUP BY c.id",
    params: [],
    tables: ["comments", "replies"]
  },
  {
    name: "nest + parent orders by child aggregate",
    sql:
      "SELECT c.id AS id, c.body AS body, " +
      "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
      "FROM comments c LEFT JOIN replies r ON r.comment_id = c.id " +
      "GROUP BY c.id ORDER BY max(r.id) DESC, c.id ASC",
    params: [],
    tables: ["comments", "replies"]
  },
  {
    name: "lateral nesting",
    sql:
      "SELECT c.id AS id, c.body AS body, sub.replies AS replies " +
      "FROM comments c LEFT JOIN LATERAL (" +
      "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id), '[]') AS replies" +
      "  FROM replies r WHERE r.comment_id = c.id" +
      ") sub ON true WHERE c.room_id = $1",
    params: [1],
    tables: ["comments", "replies"]
  },
  {
    name: "lateral nesting + per-child limit",
    sql:
      "SELECT c.id AS id, c.body AS body, sub.replies AS replies " +
      "FROM comments c LEFT JOIN LATERAL (" +
      "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id DESC), '[]') AS replies" +
      "  FROM (SELECT r.id, r.body, r.comment_id FROM replies r WHERE r.comment_id = c.id ORDER BY r.id DESC LIMIT 3) r" +
      ") sub ON true",
    params: [],
    tables: ["comments", "replies"]
  },
  {
    name: "scalar-subquery nesting",
    sql:
      "SELECT c.id AS id, c.body AS body, (" +
      "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id), '[]')" +
      "  FROM replies r WHERE r.comment_id = c.id" +
      ") AS replies FROM comments c WHERE c.room_id = $1",
    params: [1],
    tables: ["comments", "replies"]
  },
  {
    name: "scalar-subquery nesting + per-child limit",
    sql:
      "SELECT c.id AS id, (" +
      "  SELECT coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.id DESC), '[]')" +
      "  FROM (SELECT r.id, r.body, r.comment_id FROM replies r WHERE r.comment_id = c.id ORDER BY r.id DESC LIMIT 3) r" +
      ") AS replies FROM comments c",
    params: [],
    tables: ["comments", "replies"]
  },
  {
    name: "group by aggregates",
    sql: "SELECT user_id AS user_id, count(*) AS n, sum(score) AS total, min(score) AS lo, max(score) AS hi FROM comments GROUP BY user_id",
    params: [],
    tables: ["comments"]
  },
  {
    name: "count distinct",
    sql: "SELECT room_id AS room_id, count(DISTINCT user_id) AS users FROM comments GROUP BY room_id",
    params: [],
    tables: ["comments"]
  },
  {
    name: "distinct",
    sql: "SELECT DISTINCT room_id AS room_id FROM comments",
    params: [],
    tables: ["comments"]
  },
  {
    name: "order by + limit",
    sql: "SELECT id, score FROM comments WHERE room_id = $1 ORDER BY score DESC, id ASC LIMIT 3",
    params: [1],
    tables: ["comments"]
  },
  {
    name: "exists",
    sql: "SELECT c.id AS id, c.body AS body FROM comments c WHERE EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id)",
    params: [],
    tables: ["comments"]
  },
  {
    name: "not exists",
    sql: "SELECT c.id AS id FROM comments c WHERE NOT EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id)",
    params: [],
    tables: ["comments"]
  }
];

class Model {
  private readonly ids = new Map<string, number[]>();
  private seq = 0;

  randomRow(table: string, rng: Rng): Record<string, unknown> {
    const id = ++this.seq;
    switch (table) {
      case "users":
        return { id, name: rng.pick(["Ann", "Bob", "Cy", "Dee"]) };
      case "comments":
        return {
          id,
          user_id: 1 + rng.int(4),
          room_id: 1 + rng.int(3),
          body: rng.pick(["x", "y", "z"]),
          score: rng.int(10)
        };
      case "replies":
        return {
          id,
          comment_id: 1 + rng.int(8),
          body: rng.pick(["a", "b", "c"])
        };
      default:
        return { id };
    }
  }

  track(table: string, id: number): void {
    let arr = this.ids.get(table);
    if (!arr) {
      arr = [];
      this.ids.set(table, arr);
    }
    arr.push(id);
  }

  existing(table: string, rng: Rng): number | undefined {
    const arr = this.ids.get(table);
    if (!arr || arr.length === 0) return undefined;
    return arr[rng.int(arr.length)];
  }

  forget(table: string, id: number): void {
    const arr = this.ids.get(table);
    if (arr) {
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
  }
}

function randomOp(table: string, model: Model, rng: Rng): RowOp | undefined {
  const roll = rng.next();
  if (roll < 0.5 || model.existing(table, rng) === undefined) {
    const newRow = model.randomRow(table, rng);
    model.track(table, newRow.id as number);
    return { table, kind: "insert", newRow };
  }
  const id = model.existing(table, rng)!;
  if (roll < 0.8) {
    const newRow = { ...model.randomRow(table, rng), id };
    return { table, kind: "update", newRow, oldRow: { id } };
  }
  model.forget(table, id);
  return { table, kind: "delete", oldRow: { id } };
}

describe("differential: incremental == recompute", () => {
  for (const tpl of TEMPLATES) {
    it(tpl.name, async () => {
      for (const seed of [1, 7, 1337]) {
        const rng = new Rng(seed);
        const model = new Model();
        const h = await IncrementalHarness.create(tpl.sql, tpl.params, {}, PK);

        for (let txn = 0; txn < 220; txn++) {
          const opCount = 1 + rng.int(4);
          const ops: RowOp[] = [];
          for (let i = 0; i < opCount; i++) {
            const table = rng.pick(tpl.tables);
            const op = randomOp(table, model, rng);
            if (op) ops.push(op);
          }
          h.applyOps(ops);

          const diff = mapsEqual(h.incremental(), h.recomputed());
          expect(
            diff,
            `${tpl.name} seed=${seed} txn=${txn}: ${diff}`
          ).toBeUndefined();
        }
      }
    });
  }
});
