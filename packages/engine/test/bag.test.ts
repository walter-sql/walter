import { describe, it, expect } from "vitest";
import { IncrementalHarness } from "./support";
import { applyView, pendingView, type View } from "@walter-sql/view";

function mirrored(h: IncrementalHarness, view: View): View {
  const next = applyView(view, {
    type: "diff",
    shapeId: "s",
    changes: h.lastChanges
  });
  expect(next.rows).toEqual(h.snapshotRows());
  return next;
}

describe("bag semantics: identical rows are shown as many times as they occur", () => {
  it("keyless projection keeps duplicates, in order, through diffs", async () => {
    const h = await IncrementalHarness.create(
      "SELECT name FROM users ORDER BY name",
      [],
      {},
      { users: ["id"] }
    );
    h.seed([
      { table: "users", kind: "insert", newRow: { id: 1, name: "x" } },
      { table: "users", kind: "insert", newRow: { id: 2, name: "x" } },
      { table: "users", kind: "insert", newRow: { id: 3, name: "a" } }
    ]);
    let view: View = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });
    expect(h.snapshotRows()).toEqual([
      { name: "a" },
      { name: "x" },
      { name: "x" }
    ]);

    h.applyOps([
      { table: "users", kind: "insert", newRow: { id: 4, name: "x" } }
    ]);
    view = mirrored(h, view);
    expect(h.snapshotRows().length).toBe(4);

    h.applyOps([{ table: "users", kind: "delete", oldRow: { id: 1 } }]);
    view = mirrored(h, view);
    expect(h.snapshotRows()).toEqual([
      { name: "a" },
      { name: "x" },
      { name: "x" }
    ]);

    h.applyOps([
      { table: "users", kind: "insert", newRow: { id: 5, name: "0" } },
      {
        table: "users",
        kind: "update",
        newRow: { id: 3, name: "x" },
        oldRow: { id: 3 }
      }
    ]);
    view = mirrored(h, view);
    expect(h.snapshotRows()).toEqual([
      { name: "0" },
      { name: "x" },
      { name: "x" },
      { name: "x" }
    ]);

    h.applyOps([
      { table: "users", kind: "delete", oldRow: { id: 2 } },
      { table: "users", kind: "delete", oldRow: { id: 3 } },
      { table: "users", kind: "delete", oldRow: { id: 4 } }
    ]);
    view = mirrored(h, view);
    expect(h.snapshotRows()).toEqual([{ name: "0" }]);
  });

  it("copies of a parent each carry the nested collection", async () => {
    const h = await IncrementalHarness.create(
      `SELECT u.name AS name,
         (SELECT json_agg(json_build_object('id', c.id) ORDER BY c.id)
            FROM comments c WHERE c.body = u.name) AS comments
       FROM users u ORDER BY name`,
      [],
      {},
      { users: ["id"], comments: ["id"] }
    );
    h.seed([
      { table: "users", kind: "insert", newRow: { id: 1, name: "x" } },
      { table: "users", kind: "insert", newRow: { id: 2, name: "x" } }
    ]);
    let view: View = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });
    h.applyOps([
      {
        table: "comments",
        kind: "insert",
        newRow: { id: 10, user_id: 1, room_id: 1, body: "x", score: 0 }
      }
    ]);
    view = mirrored(h, view);
    expect(h.snapshotRows()).toEqual([
      { name: "x", comments: [{ id: 10 }] },
      { name: "x", comments: [{ id: 10 }] }
    ]);
    h.applyOps([{ table: "comments", kind: "delete", oldRow: { id: 10 } }]);
    view = mirrored(h, view);
    expect(h.snapshotRows()).toEqual([
      { name: "x", comments: [] },
      { name: "x", comments: [] }
    ]);
  });
});
