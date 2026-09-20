import { describe, it, expect } from "vitest";
import { IncrementalHarness, allLevels } from "./support";
import { applyView, pendingView } from "@walter-sql/view";
import type { CatalogSpec, RowOp } from "./support";
import type { Row } from "../src/ivm/zset";

const ins = (table: string, newRow: Row): RowOp => ({
  table,
  kind: "insert",
  newRow
});

const TYPES: CatalogSpec["columnTypes"] = {
  nodes: { id: "int4", project_id: "int4", label: "text" },
  node_parameters: { id: "int4", node_id: "int4", parameter_id: "int4" },
  parameters: { id: "int4", project_id: "int4", name: "text" }
};

const PK = {
  nodes: ["id"],
  node_parameters: ["id"],
  parameters: ["id"]
};

const SQL =
  "SELECT n.id AS id, (" +
  "  SELECT coalesce(json_agg(json_build_object('id', pa.id, 'name', pa.name) ORDER BY pa.id), '[]')" +
  "  FROM node_parameters np JOIN parameters pa ON pa.id = np.parameter_id" +
  "  WHERE np.node_id = n.id" +
  ") AS parameters FROM nodes n WHERE n.project_id = $1";

describe("junction-backed collection", () => {
  it("keys elements by the target PK, not the bridge", async () => {
    const h = await IncrementalHarness.create(
      SQL,
      [1],
      { columnTypes: TYPES },
      PK
    );
    expect(allLevels(h.plan)[1]!.keyColumns).toEqual(["__corr_0", "id"]);
  });

  it("editing a shared target updates ALL owning parents", async () => {
    const h = await IncrementalHarness.create(
      SQL,
      [1],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("nodes", { id: 1, project_id: 1, label: "n1" }),
      ins("nodes", { id: 2, project_id: 1, label: "n2" }),
      ins("nodes", { id: 3, project_id: 1, label: "n3" }),
      ins("parameters", { id: 7, project_id: 1, name: "aaa" }),
      ins("node_parameters", { id: 101, node_id: 1, parameter_id: 7 }),
      ins("node_parameters", { id: 102, node_id: 2, parameter_id: 7 }),
      ins("node_parameters", { id: 103, node_id: 3, parameter_id: 7 })
    ]);

    let view = applyView(pendingView, {
      type: "snapshot",
      shapeId: "s",
      rows: h.snapshotRows()
    });

    const changes = h.applyOps([
      {
        table: "parameters",
        kind: "update",
        newRow: { id: 7, project_id: 1, name: "aaab" },
        oldRow: { id: 7 }
      }
    ]);
    view = applyView(view, { type: "diff", shapeId: "s", changes });

    expect(view.rows).toEqual([
      { id: 1, parameters: [{ id: 7, name: "aaab" }] },
      { id: 2, parameters: [{ id: 7, name: "aaab" }] },
      { id: 3, parameters: [{ id: 7, name: "aaab" }] }
    ]);
  });

  it("a target field edit is a granular set, not remove+add", async () => {
    const h = await IncrementalHarness.create(
      SQL,
      [1],
      { columnTypes: TYPES },
      PK
    );
    h.seed([
      ins("nodes", { id: 1, project_id: 1, label: "n1" }),
      ins("parameters", { id: 7, project_id: 1, name: "old" }),
      ins("node_parameters", { id: 100, node_id: 1, parameter_id: 7 })
    ]);
    expect(h.snapshotRows()).toEqual([
      { id: 1, parameters: [{ id: 7, name: "old" }] }
    ]);

    const changes = h.applyOps([
      {
        table: "parameters",
        kind: "update",
        newRow: { id: 7, project_id: 1, name: "new" },
        oldRow: { id: 7 }
      }
    ]);
    expect(changes).toEqual([
      {
        op: "update",
        index: 0,
        ops: [
          {
            op: "nest",
            field: "parameters",
            ops: [
              {
                op: "update",
                index: 0,
                ops: [{ op: "set", field: "name", value: "new" }]
              }
            ]
          }
        ]
      }
    ]);
  });
});
