import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { getEventListeners } from "node:events";
import type { AddressInfo } from "node:net";
import {
  EngineClient,
  WalterError,
  type RowValue,
  type ServerMessage,
  type ViewMessage
} from "../src";

const SHAPE = { sql: "SELECT id FROM t", params: [] };

const frame = (msg: ServerMessage) => JSON.stringify(msg);
const snapshotOf = (shapeId: string, rows: RowValue[]) =>
  frame({ type: "snapshot", shapeId, rows });

type Responder = (socket: WebSocket, shapeId: string, nth: number) => void;
const plain: Responder = (socket, shapeId) =>
  socket.send(snapshotOf(shapeId, [{ id: 1 }]));

function fakeEngine(port = 0, respond: Responder = plain) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  let subscribes = 0;
  wss.on("connection", socket => {
    socket.on("message", data => {
      const msg = JSON.parse(String(data));
      if (msg.type === "subscribe") respond(socket, msg.shapeId, ++subscribes);
    });
  });
  return {
    wss,
    port: () => (wss.address() as AddressInfo).port,
    subscribes: () => subscribes,
    ready: new Promise<void>(r => wss.on("listening", () => r())),
    stop: () =>
      new Promise<void>(r => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(() => r());
      })
  };
}

const race = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms)
    )
  ]);

const until = (cond: () => boolean, ms = 2000) =>
  race(
    new Promise<void>(resolve => {
      const tick = setInterval(() => {
        if (cond()) {
          clearInterval(tick);
          resolve();
        }
      }, 10);
    }),
    ms
  );

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function connect(respond?: Responder) {
  const server = fakeEngine(0, respond);
  await server.ready;
  const client = new EngineClient(`ws://127.0.0.1:${server.port()}`);
  cleanups.push(() => server.stop());
  cleanups.push(() => client.close());
  return { server, client };
}

describe("EngineClient lifecycle", () => {
  it("close() ends active streams", async () => {
    const { client } = await connect();
    const messages: ViewMessage[] = [];
    const done = (async () => {
      for await (const msg of client.stream(SHAPE)) messages.push(msg);
    })();
    await until(() => messages.length > 0);
    client.close();
    await race(done);
    expect(messages[0]).toMatchObject({ type: "snapshot", rows: [{ id: 1 }] });
  });

  it("close() rejects pending snapshots", async () => {
    const { client } = await connect(() => {});
    const pending = client.snapshot(SHAPE);
    setTimeout(() => client.close(), 50);
    await expect(race(pending)).rejects.toMatchObject({ code: "closed" });
  });

  it("stream() after close() ends immediately", async () => {
    const { client } = await connect();
    client.close();
    for await (const _ of client.stream(SHAPE)) throw new Error("unreachable");
    await expect(race(client.snapshot(SHAPE))).rejects.toMatchObject({
      code: "closed"
    });
  });

  it("snapshot() resolves with the first snapshot rows", async () => {
    const { client } = await connect();
    expect(await race(client.snapshot(SHAPE))).toEqual([{ id: 1 }]);
  });

  it("abort ends the stream and detaches the signal listener", async () => {
    const { client } = await connect();
    const controller = new AbortController();

    for await (const msg of client.stream(SHAPE, controller.signal)) {
      expect(msg.type).toBe("snapshot");
      break;
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const consumed = (async () => {
      for await (const _ of client.stream(SHAPE, controller.signal));
    })();
    controller.abort();
    await race(consumed);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("reconnect re-subscribes and delivers a fresh snapshot", async () => {
    const { server, client } = await connect();
    const snapshots: ViewMessage[] = [];
    const done = (async () => {
      for await (const msg of client.stream(SHAPE)) {
        snapshots.push(msg);
        if (snapshots.length === 2) break;
      }
    })();
    await until(() => snapshots.length === 1);
    const port = server.port();
    await server.stop();
    const revived = fakeEngine(port);
    cleanups.push(() => revived.stop());
    await revived.ready;
    await race(done, 5000);
    expect(snapshots.map(s => s.type)).toEqual(["snapshot", "snapshot"]);
  }, 10000);
});

describe("EngineClient answers", () => {
  it("streams failed and the snapshot that heals it; a one-shot rejects while failed", async () => {
    const { client } = await connect((socket, shapeId) => {
      socket.send(frame({ type: "failed", shapeId }));
      setTimeout(() => socket.send(snapshotOf(shapeId, [{ id: 2 }])), 50);
    });
    const seen: ViewMessage[] = [];
    for await (const msg of client.stream(SHAPE)) {
      seen.push(msg);
      if (seen.length === 2) break;
    }
    expect(seen.map(m => m.type)).toEqual(["failed", "snapshot"]);

    const err = (await race(client.snapshot(SHAPE)).catch(
      e => e
    )) as WalterError;
    expect(err).toBeInstanceOf(WalterError);
    expect(err.code).toBe("failed");
  });

  it("a refusal rejects the stream with its code", async () => {
    const { client } = await connect((socket, shapeId) =>
      socket.send(
        frame({ type: "error", shapeId, code: "parse_error", message: "nope" })
      )
    );
    const err = (await race(client.snapshot(SHAPE)).catch(
      e => e
    )) as WalterError;
    expect(err).toBeInstanceOf(WalterError);
    expect(err.code).toBe("parse_error");
  });

  it("a consumer far behind is reset: resubscribed, and read from the fresh snapshot", async () => {
    const { server, client } = await connect((socket, shapeId, nth) => {
      socket.send(snapshotOf(shapeId, [{ id: nth }]));
      if (nth === 1)
        for (let i = 0; i < 5000; i++)
          socket.send(frame({ type: "diff", shapeId, changes: [] }));
    });
    const stream = client.stream(SHAPE);
    await until(() => server.subscribes() === 2);
    for await (const msg of stream) {
      expect(msg).toMatchObject({ type: "snapshot", rows: [{ id: 2 }] });
      break;
    }
  });
});
