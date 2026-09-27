import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sseStream, WalterError } from "../src";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fail(terminal: boolean) {
    this.readyState = terminal
      ? FakeEventSource.CLOSED
      : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as any).EventSource = FakeEventSource;
});
afterEach(() => {
  delete (globalThis as any).EventSource;
});

describe("sseStream", () => {
  it("parses events, survives reconnects, and throws when the source is closed", async () => {
    const stream = sseStream<{ id: number }>("/live");
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/live");
    source.emit({ type: "snapshot", shapeId: "s", rows: [{ id: 1 }] });
    source.fail(false);
    source.emit({ type: "snapshot", shapeId: "s", rows: [{ id: 2 }] });
    source.fail(true);
    const rows: number[][] = [];
    const error = await (async () => {
      for await (const msg of stream)
        if (msg.type === "snapshot") rows.push(msg.rows.map(r => r.id));
    })().catch(e => e);
    expect(rows).toEqual([[1], [2]]);
    expect(error).toBeInstanceOf(WalterError);
    expect(error.code).toBe("closed");
  });

  it("an error frame throws its code and closes the source", async () => {
    const stream = sseStream("/live");
    const source = FakeEventSource.instances[0]!;
    source.emit({ type: "error", code: "parse_error" });
    const error = await (async () => {
      for await (const _ of stream);
    })().catch(e => e);
    expect(error).toBeInstanceOf(WalterError);
    expect(error.code).toBe("parse_error");
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("abort closes the source", async () => {
    const controller = new AbortController();
    const stream = sseStream("/live", controller.signal);
    const consumed = (async () => {
      for await (const _ of stream);
    })();
    controller.abort();
    await consumed;
    expect(FakeEventSource.instances[0]!.readyState).toBe(
      FakeEventSource.CLOSED
    );
  });
});
