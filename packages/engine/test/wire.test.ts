import { describe, it, expect } from "vitest";
import {
  diffFrame,
  encodeServerMessage,
  snapshotFrame
} from "../src/server/wire";
import type { CollectionOp, ServerMessage } from "@walter-sql/view";

describe("shared-payload frames", () => {
  const shapeId = 'q"1\\ ';
  const rows = [{ id: 1, name: 'a"b', tags: ["x", null], nested: { d: 1.5 } }];
  const changes: CollectionOp[] = [
    { op: "add", value: rows[0]! },
    { op: "update", index: 0, ops: [{ op: "set", field: "name", value: null }] }
  ];

  it("splice byte-identically to the message form", () => {
    const snap: ServerMessage = { type: "snapshot", shapeId, rows };
    const diff: ServerMessage = { type: "diff", shapeId, changes };
    expect(snapshotFrame(shapeId, JSON.stringify(rows))).toBe(
      encodeServerMessage(snap)
    );
    expect(diffFrame(shapeId, JSON.stringify(changes))).toBe(
      encodeServerMessage(diff)
    );
  });
});
