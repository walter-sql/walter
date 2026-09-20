import { setMaxListeners } from "node:events";
import type { IncomingMessage } from "node:http";
import { ReconnectingWebSocket } from "./reconnecting-ws";
import { WalterError, snapshot } from "@walter-sql/view";
import type {
  ClientMessage,
  RowValue,
  ServerMessage,
  ViewMessage
} from "@walter-sql/view";

export interface EngineShape<TRow extends RowValue = RowValue> {
  sql: string;
  params?: unknown[];
  readonly row?: TRow;
}

export interface EngineClientOptions {
  secret?: string;
  headers?: Record<string, string>;
  onUpgrade?: (res: IncomingMessage) => void;
  onHandshakeRejected?: (statusCode: number) => void;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

const MAX_BACKLOG = 1_000;

interface Sub<TRow extends RowValue = any> {
  shapeId: string;
  shape: EngineShape<TRow>;
  listener: (msg: ServerMessage<TRow>) => void;
}

export class EngineClient {
  private readonly ws: ReconnectingWebSocket;
  private readonly subs = new Map<string, Sub>();
  private readonly closer = new AbortController();
  private readonly statusListeners = new Set<
    (status: ConnectionStatus) => void
  >();
  private seq = 0;

  constructor(url: string, options: EngineClientOptions = {}) {
    setMaxListeners(0, this.closer.signal);
    this.ws = new ReconnectingWebSocket(url, {
      headers: options.secret
        ? { ...options.headers, authorization: `Bearer ${options.secret}` }
        : options.headers,
      maxReconnectionDelay: 5000,
      onUpgrade: options.onUpgrade,
      onHandshakeRejected: options.onHandshakeRejected
    });
    this.ws.addEventListener("open", () => {
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
      this.emitStatus();
    });
    this.ws.addEventListener("close", () => this.emitStatus());
    this.ws.addEventListener("message", event => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      const { shapeId } = msg;
      if (!shapeId) return;
      const sub = this.subs.get(shapeId);
      if (!sub) return;
      if (msg.type === "error") this.subs.delete(shapeId);
      sub.listener(msg);
    });
  }

  subscribe<TRow extends RowValue = RowValue>(
    shape: EngineShape<TRow>,
    listener: (msg: ServerMessage<TRow>) => void
  ): () => void {
    const sub: Sub = { shapeId: `px${this.seq++}`, shape, listener };
    this.subs.set(sub.shapeId, sub);
    if (this.isOpen) this.sendSubscribe(sub);
    return () => {
      if (this.subs.delete(sub.shapeId) && this.isOpen) {
        this.send({ type: "unsubscribe", shapeId: sub.shapeId });
      }
    };
  }

  stream<TRow extends RowValue = RowValue>(
    shape: EngineShape<TRow>,
    signal?: AbortSignal
  ): AsyncIterable<ViewMessage<TRow>> {
    const attach = () =>
      this.subscribe<TRow>(shape, msg => {
        if (msg.type === "error") {
          channel.fail(new WalterError(msg.code, msg.message));
        } else {
          channel.push(msg);
        }
      });
    const channel = makeChannel<ViewMessage<TRow>>(MAX_BACKLOG, () => {
      off();
      off = attach();
    });
    let off = attach();
    const cleanup = () => {
      signal?.removeEventListener("abort", cleanup);
      this.closer.signal.removeEventListener("abort", cleanup);
      off();
      channel.end();
    };
    if (signal?.aborted || this.closer.signal.aborted) cleanup();
    else {
      signal?.addEventListener("abort", cleanup, { once: true });
      this.closer.signal.addEventListener("abort", cleanup, { once: true });
    }
    return channel.iterate(cleanup);
  }

  snapshot<TRow extends RowValue = RowValue>(
    shape: EngineShape<TRow>
  ): Promise<TRow[]> {
    return snapshot(this.stream(shape));
  }

  get status(): ConnectionStatus {
    switch (this.ws.readyState) {
      case 0:
        return "connecting";
      case 1:
        return "open";
      default:
        return "closed";
    }
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  close(): void {
    this.subs.clear();
    this.closer.abort();
    this.ws.close();
  }

  private get isOpen(): boolean {
    return this.ws.readyState === 1;
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }

  private sendSubscribe(sub: Sub): void {
    this.send({
      type: "subscribe",
      shapeId: sub.shapeId,
      sql: sub.shape.sql,
      params: sub.shape.params ?? []
    });
  }

  private send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}

function makeChannel<T>(capacity: number, onOverflow: () => void) {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;

  const signal = () => {
    wake?.();
    wake = null;
  };

  return {
    push(value: T) {
      if (done) return;
      if (queue.length === capacity) {
        queue.length = 0;
        onOverflow();
        return;
      }
      queue.push(value);
      signal();
    },
    fail(e: Error) {
      if (done) return;
      done = true;
      error = e;
      signal();
    },
    end() {
      done = true;
      signal();
    },
    iterate(onFinish: () => void): AsyncIterable<T> {
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              while (queue.length > 0) yield queue.shift()!;
              if (error) throw error;
              if (done) return;
              await new Promise<void>(r => {
                wake = r;
              });
            }
          } finally {
            onFinish();
          }
        }
      };
    }
  };
}
