import { describe, it, expect } from "vitest";
import { materialize, subscriptionStream, type Sink } from "../src";
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

describe("subscriptionStream", () => {
  function source(signal?: AbortSignal) {
    const sinks: Sink<ViewMessage>[] = [];
    let unsubscribed = 0;
    const stream = subscriptionStream(
      sink => {
        sinks.push(sink);
        return () => unsubscribed++;
      },
      { signal }
    );
    return {
      stream,
      sink: () => sinks.at(-1)!,
      subscribed: () => sinks.length,
      unsubscribed: () => unsubscribed
    };
  }

  it("delivers messages in order and drains the backlog before a terminal error", async () => {
    const { stream, sink } = source();
    sink().next(snapshot([{ id: 1 }]));
    sink().next(failed);
    sink().error(new Error("boom"));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const msg of stream) seen.push(msg.type);
      })()
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["snapshot", "failed"]);
  });

  it("completes when the source completes and unsubscribes once", async () => {
    const { stream, sink, unsubscribed } = source();
    setTimeout(() => sink().complete(), 10);
    for await (const _ of stream) throw new Error("unreachable");
    expect(unsubscribed()).toBe(1);
  });

  it("abort ends the stream, unsubscribes, and detaches the listener", async () => {
    const controller = new AbortController();
    const { stream, unsubscribed } = source(controller.signal);
    const consumed = (async () => {
      for await (const _ of stream);
    })();
    controller.abort();
    await consumed;
    expect(unsubscribed()).toBe(1);
    const { subscribed } = source(controller.signal);
    expect(subscribed()).toBe(0);
  });

  it("breaking out unsubscribes", async () => {
    const { stream, sink, unsubscribed } = source();
    sink().next(snapshot([]));
    for await (const _ of stream) break;
    expect(unsubscribed()).toBe(1);
  });

  it("a consumer far behind is reset: resubscribed and read from the fresh snapshot", async () => {
    const { stream, sink, subscribed } = source();
    sink().next(snapshot([{ id: 1 }]));
    for (let i = 0; i < 1000; i++)
      sink().next({ type: "diff", shapeId: "s", changes: [] });
    expect(subscribed()).toBe(2);
    sink().next(snapshot([{ id: 2 }]));
    for await (const msg of stream) {
      expect(msg).toMatchObject({ type: "snapshot", rows: [{ id: 2 }] });
      break;
    }
  });
});
