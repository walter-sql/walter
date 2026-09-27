import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  sseResponse,
  subscriptionStream,
  writeSSE,
  WalterError,
  type MessageSource,
  type Sink,
  type ViewMessage
} from "../src";

const snapshot: ViewMessage = { type: "snapshot", shapeId: "s", rows: [] };
const diff: ViewMessage = { type: "diff", shapeId: "s", changes: [] };

function feed() {
  let sink: Sink<ViewMessage> | undefined;
  let signal: AbortSignal | undefined;
  const source: MessageSource = s => {
    signal = s;
    return subscriptionStream(next => {
      sink = next;
      return () => {};
    }, s);
  };
  return {
    source,
    push: (msg: ViewMessage) => sink!.next(msg),
    fail: (error: unknown) => sink!.error(error),
    subscribed: () => sink !== undefined,
    aborted: () => signal?.aborted === true
  };
}

let servers: Server[] = [];
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
  servers = [];
});

async function listen(handler: (res: ServerResponse) => Promise<void>) {
  const server = createServer((_, res) => void handler(res));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function open(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const next = async (): Promise<string | undefined> => {
    while (frames.length === 0) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;
      frames.push(...parts);
    }
    return frames.shift();
  };
  const data = async (): Promise<unknown> => {
    for (;;) {
      const frame = await next();
      if (frame === undefined) return undefined;
      if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
    }
  };
  return { res, next, data, abort: () => controller.abort() };
}

const until = (cond: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (cond()) (clearInterval(tick), resolve());
      else if (Date.now() - started > 2000)
        (clearInterval(tick), reject(new Error("timed out")));
    }, 10);
  });

type Serve = (
  res: ServerResponse,
  source: MessageSource,
  heartbeat: number
) => Promise<void>;

const forms: Record<string, Serve> = {
  writeSSE: (res, source, heartbeat) => writeSSE(res, source, { heartbeat }),
  sseResponse: async (res, source, heartbeat) => {
    const { status, headers, body } = sseResponse(source, { heartbeat });
    res.writeHead(status, Object.fromEntries(headers));
    const reader = body!.getReader();
    const cancel = () => reader.cancel();
    res.closed ? cancel() : res.once("close", cancel);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }
};

describe.each(Object.entries(forms))("%s", (_, serve) => {
  const listenWith = (
    source: MessageSource,
    gate: (res: ServerResponse) => Promise<void> = async () => {}
  ) =>
    listen(async res => {
      await gate(res);
      await serve(res, source, 30);
    });

  it("frames messages, sends heartbeats, and aborts the source when the consumer leaves", async () => {
    const { source, push, subscribed, aborted } = feed();
    const { res, next, data, abort } = await open(await listenWith(source));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await until(subscribed);
    push(snapshot);
    expect(await data()).toEqual(snapshot);
    while ((await next()) !== ": ");
    push(diff);
    expect(await data()).toEqual(diff);
    abort();
    await until(aborted);
  });

  it.each([
    [new WalterError("parse_error", { cause: "SECRET SQL" }), "parse_error"],
    [new Error("SECRET"), "internal"]
  ])(
    "a throwing source ends the stream with a code-only error frame",
    async (error, code) => {
      const { source, fail, subscribed } = feed();
      const { res, next, data } = await open(await listenWith(source));
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      await until(subscribed);
      fail(error);
      expect(await data()).toEqual({ type: "error", code });
      expect(await next()).toBeUndefined();
    }
  );

  it("leaving before the first message aborts the source", async () => {
    const { source, subscribed, aborted } = feed();
    const { abort } = await open(await listenWith(source));
    await until(subscribed);
    abort();
    await until(aborted);
  });

  it("a request signal ends the stream, even when it is already aborted", async () => {
    const live = feed();
    const controller = new AbortController();
    const reader = sseResponse(live.source, {
      signal: controller.signal,
      heartbeat: 10_000
    }).body!.getReader();
    await until(live.subscribed);
    live.push(snapshot);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      `data: ${JSON.stringify(snapshot)}\n\n`
    );
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect(live.aborted()).toBe(true);

    const gone = feed();
    const response = sseResponse(gone.source, { signal: controller.signal });
    expect(await response.text()).toBe("");
    expect(gone.subscribed()).toBe(false);
    expect(gone.aborted()).toBe(true);
  });

  it("a client already gone when the handler runs aborts the source", async () => {
    const { source, aborted } = feed();
    let received = false;
    const url = await listenWith(source, async res => {
      received = true;
      await until(() => res.closed);
    });
    const controller = new AbortController();
    fetch(url, { signal: controller.signal }).catch(() => {});
    await until(() => received);
    controller.abort();
    await until(aborted);
  });
});
