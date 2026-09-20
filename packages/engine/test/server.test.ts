import { describe, it, expect } from "vitest";
import WebSocket, { type WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { WalterServer } from "../src/server/server";
import { ShapeRouter } from "../src/subscriptions/cluster";

const stubRouter = () => new ShapeRouter(undefined, [], "test", undefined, 0);

const boundPort = (server: WalterServer): number =>
  ((server as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo)
    .port;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const dial = (port: number, opts?: WebSocket.ClientOptions) =>
  new Promise<number | "open">(resolve => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, opts);
    client.on("open", () => {
      client.terminate();
      resolve("open");
    });
    client.on("unexpected-response", (_req, res) => {
      client.terminate();
      resolve(res.statusCode ?? 0);
    });
    client.on("error", () => resolve(0));
  });

describe("WalterServer handshake", () => {
  it("rejects any Origin-bearing upgrade, even without a secret", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1");
    await server.listen();
    const port = boundPort(server);
    expect(await dial(port)).toBe("open");
    expect(await dial(port, { origin: "http://evil.example" })).toBe(401);
    await server.close();
  });

  it("requires the exact bearer secret when configured", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1", "s3cret");
    await server.listen();
    const port = boundPort(server);
    expect(await dial(port)).toBe(401);
    expect(
      await dial(port, { headers: { authorization: "Bearer wrong" } })
    ).toBe(401);
    expect(
      await dial(port, {
        origin: "http://evil.example",
        headers: { authorization: "Bearer s3cret" }
      })
    ).toBe(401);
    expect(
      await dial(port, { headers: { authorization: "Bearer s3cret" } })
    ).toBe("open");
    await server.close();
  });

  it("EngineClient authenticates via the secret option", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1", "s3cret");
    await server.listen();
    const { EngineClient } = await import("@walter-sql/client");
    const client = new EngineClient(`ws://127.0.0.1:${boundPort(server)}`, {
      secret: "s3cret"
    });
    await new Promise<void>(resolve => {
      client.onStatusChange(status => status === "open" && resolve());
    });
    client.close();
    await server.close();
  });
});

describe("WalterServer.listen", () => {
  it("rejects when the port is taken", async () => {
    const first = new WalterServer(stubRouter(), 0, "127.0.0.1");
    await first.listen();
    const second = new WalterServer(
      stubRouter(),
      boundPort(first),
      "127.0.0.1"
    );
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
    await first.close();
  });
});

describe("WalterServer.close", () => {
  it("resolves while a client is connected", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1");
    await server.listen();

    const client = new WebSocket(`ws://127.0.0.1:${boundPort(server)}`);
    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    const clientClosed = new Promise<void>(resolve =>
      client.on("close", () => resolve())
    );

    const closing = server.close();
    try {
      const outcome = await Promise.race([
        closing.then(() => "closed"),
        sleep(1000).then(() => "hang")
      ]);
      expect(outcome).toBe("closed");
      await clientClosed;
    } finally {
      client.terminate();
      await closing;
    }
  });

  it("returns when called before listen()", async () => {
    const server = new WalterServer(stubRouter(), 0, "127.0.0.1");
    const outcome = await Promise.race([
      server.close().then(() => "closed"),
      sleep(250).then(() => "hang")
    ]);
    expect(outcome).toBe("closed");
  });
});

describe("root export surface", () => {
  it("exposes exactly WalterEngine", async () => {
    expect(Object.keys(await import("../src/index"))).toEqual(["WalterEngine"]);
  });
});
