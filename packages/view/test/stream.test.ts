import { describe, it, expect } from "vitest";
import { materialize } from "../src";
import type { ViewMessage } from "../src";

const snapshot = (rows: { id: number }[]): ViewMessage => ({
  type: "snapshot",
  shapeId: "s",
  rows
});
const failed: ViewMessage = { type: "failed", shapeId: "s" };

async function* replay(msgs: ViewMessage[]) {
  yield* msgs;
}

describe("materialize", () => {
  it("yields the view after every message; rows hold through failed", async () => {
    const views = [];
    for await (const v of materialize(
      replay([snapshot([{ id: 1 }]), failed, snapshot([{ id: 2 }])])
    ))
      views.push([v.status, v.rows]);
    expect(views).toEqual([
      ["live", [{ id: 1 }]],
      ["failed", [{ id: 1 }]],
      ["live", [{ id: 2 }]]
    ]);
  });
});
