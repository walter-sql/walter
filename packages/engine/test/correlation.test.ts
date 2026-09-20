import { describe, it, expect } from "vitest";
import {
  IncrementalHarness,
  compileShape,
  recompute,
  viewToMap,
  mapsEqual
} from "./support";
import { applyView, pendingView } from "@walter-sql/view";
import { StateStore } from "./state-store";
import { MemRowSource } from "../src/lazy/rowsource";
import { LazyTree } from "../src/lazy/lazy-tree";
import { applyTxn, commit, seedTree, type RowOp } from "./support";
import type { CollectionOp } from "@walter-sql/view";
import type { Row } from "../src/ivm/zset";

const SQL = `
  SELECT c.id AS id, c.room_id AS room_id,
    (SELECT json_agg(json_build_object('id', p.id, 'label', p.label))
     FROM pins p WHERE p.room_id = c.room_id) AS pins
  FROM comments c`;
const TYPES = {
  comments: { id: "int4", room_id: "int4", body: "text" },
  pins: { id: "int4", room_id: "int4", label: "text" }
};
const PK = { comments: ["id"], pins: ["id"] };

const ins = (table: string, newRow: Row): RowOp => ({
  table,
  kind: "insert",
  newRow
});

describe("value-correlated child collections (non-PK / mutable parent key)", () => {
  it("propagates a shared collection's edit to every parent that references it", async () => {
    const h = await IncrementalHarness.create(
      SQL,
      [],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("pins", { id: 100, room_id: 1, label: "x" }),
      ins("comments", { id: 10, room_id: 1, body: "a" }),
      ins("comments", { id: 11, room_id: 1, body: "b" })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, room_id: 1, pins: [{ id: 100, label: "x" }] },
      { id: 11, room_id: 1, pins: [{ id: 100, label: "x" }] }
    ]);

    const changes = h.applyOps([
      {
        table: "pins",
        kind: "update",
        newRow: { id: 100, room_id: 1, label: "y" },
        oldRow: { id: 100 }
      }
    ]);
    const nest = [
      {
        op: "nest",
        field: "pins",
        ops: [
          {
            op: "update",
            index: 0,
            ops: [{ op: "set", field: "label", value: "y" }]
          }
        ]
      }
    ];
    const updates = changes as Extract<CollectionOp, { op: "update" }>[];
    expect([...updates].sort((a, b) => a.index - b.index)).toEqual([
      { op: "update", index: 0, ops: nest },
      { op: "update", index: 1, ops: nest }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("reships the whole collection when a parent's correlation key changes", async () => {
    const h = await IncrementalHarness.create(
      SQL,
      [],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("pins", { id: 100, room_id: 1, label: "x" }),
      ins("pins", { id: 200, room_id: 2, label: "z" }),
      ins("comments", { id: 10, room_id: 1, body: "a" }),
      ins("comments", { id: 11, room_id: 1, body: "b" })
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
        newRow: { id: 10, room_id: 2, body: "a" },
        oldRow: { id: 10 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          { op: "set", field: "room_id", value: 2 },
          { op: "set", field: "pins", value: [{ id: 200, label: "z" }] }
        ]
      }
    ]);

    view = applyView(view, { type: "diff", shapeId: "s", changes });
    expect(view.rows).toEqual([
      { id: 10, room_id: 2, pins: [{ id: 200, label: "z" }] },
      { id: 11, room_id: 1, pins: [{ id: 100, label: "x" }] }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });
});

const C_SQL = `
  SELECT c.id AS id, c.org_id AS org_id, c.room_id AS room_id,
    (SELECT json_agg(json_build_object('id', p.id, 'label', p.label))
     FROM pins p WHERE p.org_id = c.org_id AND p.room_id = c.room_id) AS pins
  FROM comments c`;
const C_TYPES = {
  comments: { id: "int4", org_id: "int4", room_id: "int4", body: "text" },
  pins: { id: "int4", org_id: "int4", room_id: "int4", label: "text" }
};
const C_PK = { comments: ["id"], pins: ["id"] };

describe("composite (multi-column) correlation", () => {
  it("joins on the whole key tuple, not either column alone", async () => {
    const h = await IncrementalHarness.create(
      C_SQL,
      [],
      { columnTypes: C_TYPES },
      C_PK
    );
    h.seed([
      ins("pins", { id: 1, org_id: 1, room_id: 1, label: "match" }),
      ins("pins", { id: 2, org_id: 1, room_id: 2, label: "wrong-room" }),
      ins("pins", { id: 3, org_id: 2, room_id: 1, label: "wrong-org" }),
      ins("comments", { id: 10, org_id: 1, room_id: 1, body: "a" })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 10, org_id: 1, room_id: 1, pins: [{ id: 1, label: "match" }] }
    ]);
    expect(mapsEqual(h.incremental(), h.recomputed())).toBeUndefined();
  });

  it("lazy pull == recompute across the composite key", async () => {
    const opts = { columnTypes: C_TYPES, keyColumnsByTable: C_PK };
    const { query, shape } = await compileShape(C_SQL, [], opts);
    const state = new StateStore();
    for (const [t, cols] of Object.entries(C_PK)) state.setKeyColumns(t, cols);
    const lazy = new LazyTree(shape, [], new MemRowSource(t => state.rows(t)));

    state.ingest([
      ins("pins", { id: 1, org_id: 1, room_id: 1, label: "a" }),
      ins("pins", { id: 2, org_id: 2, room_id: 1, label: "b" }),
      ins("comments", { id: 10, org_id: 1, room_id: 1, body: "x" }),
      ins("comments", { id: 11, org_id: 2, room_id: 1, body: "y" })
    ]);
    await seedTree(lazy);
    expect(
      mapsEqual(viewToMap(lazy.materializer), recompute(query, [], opts, state))
    ).toBeUndefined();

    const ops: RowOp[] = [
      ins("pins", { id: 3, org_id: 1, room_id: 1, label: "c" }),
      {
        table: "comments",
        kind: "update",
        newRow: { id: 11, org_id: 1, room_id: 1, body: "y" },
        oldRow: { id: 11 }
      }
    ];
    state.ingest(ops);
    await applyTxn(lazy, commit(1, ops));
    expect(
      mapsEqual(viewToMap(lazy.materializer), recompute(query, [], opts, state))
    ).toBeUndefined();
  });
});
