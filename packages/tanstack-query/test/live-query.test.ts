import { describe, it, expect } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { WalterError, type ViewMessage } from "@walter-sql/view";
import { liveQueryOptions, snapshotQueryOptions } from "../src";

const snapshot = (rows: { id: number }[]): ViewMessage => ({
  type: "snapshot",
  shapeId: "s",
  rows
});
const failed: ViewMessage = { type: "failed", shapeId: "s" };

async function* replay(msgs: ViewMessage[]) {
  yield* msgs;
}

function feed() {
  const queue: ViewMessage[] = [];
  let wake = () => {};
  const source = (signal: AbortSignal): AsyncIterable<ViewMessage> => ({
    async *[Symbol.asyncIterator]() {
      signal.addEventListener("abort", () => wake(), { once: true });
      while (!signal.aborted) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>(r => (wake = r));
      }
    }
  });
  const push = (msg: ViewMessage) => {
    queue.push(msg);
    wake();
  };
  return { source, push };
}

const tick = () => new Promise(r => setTimeout(r, 10));

describe("liveQueryOptions", () => {
  it("writes each view to the cache; failed is the error state with rows kept, healed by a snapshot", async () => {
    const client = new QueryClient();
    const key = ["live"] as const;
    const { source, push } = feed();
    const observer = new QueryObserver(
      client,
      client.defaultQueryOptions(
        liveQueryOptions({
          queryKey: key,
          queryFn: async ({ signal }) => source(signal)
        })
      )
    );
    const off = observer.subscribe(() => {});
    await tick();
    push(snapshot([{ id: 1 }]));
    await tick();
    expect(observer.getCurrentResult()).toMatchObject({
      status: "success",
      fetchStatus: "fetching",
      data: [{ id: 1 }]
    });

    push({
      type: "diff",
      shapeId: "s",
      changes: [{ op: "add", value: { id: 2 } }]
    });
    await tick();
    expect(observer.getCurrentResult().data).toEqual([{ id: 1 }, { id: 2 }]);

    push(failed);
    await tick();
    const during = observer.getCurrentResult();
    expect(during.status).toBe("error");
    expect(during.error).toBeInstanceOf(WalterError);
    expect(during.data).toEqual([{ id: 1 }, { id: 2 }]);

    push(snapshot([{ id: 3 }]));
    await tick();
    expect(observer.getCurrentResult()).toMatchObject({
      status: "success",
      error: null,
      data: [{ id: 3 }]
    });

    off();
    await tick();
    expect(client.getQueryState(key)).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      data: [{ id: 3 }]
    });
  });

  it("treats a stream that ends unasked as a failure", async () => {
    const client = new QueryClient();
    const key = ["ended"] as const;
    const observer = new QueryObserver(
      client,
      client.defaultQueryOptions(
        liveQueryOptions({
          queryKey: key,
          queryFn: async () => replay([snapshot([{ id: 1 }])]),
          retry: false
        })
      )
    );
    const off = observer.subscribe(() => {});
    await tick();
    expect(observer.getCurrentResult()).toMatchObject({
      status: "error",
      data: [{ id: 1 }]
    });
    off();
  });

  it("puts the live defaults under the caller's options", () => {
    const options = liveQueryOptions({
      queryKey: ["k"],
      queryFn: async () => replay([]),
      retry: 2
    });
    expect(options).toMatchObject({ refetchOnMount: "always", retry: 2 });
  });
});

describe("snapshotQueryOptions", () => {
  it("resolves at the first snapshot and rejects while failed", async () => {
    const client = new QueryClient();
    const once = (msgs: ViewMessage[]) =>
      snapshotQueryOptions({
        queryKey: [msgs],
        queryFn: async () => replay(msgs),
        retry: false
      });
    expect(await client.fetchQuery(once([snapshot([{ id: 1 }])]))).toEqual([
      { id: 1 }
    ]);
    await expect(client.fetchQuery(once([failed]))).rejects.toBeInstanceOf(
      WalterError
    );
  });
});
