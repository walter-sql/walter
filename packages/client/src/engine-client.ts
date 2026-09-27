import type { IncomingMessage, ServerResponse } from "node:http";
import { ReconnectingWebSocket } from "./reconnecting-ws";
import { pipeSSE, sseResponse, type SseOptions } from "./sse";
import { WalterError, snapshot, subscriptionStream } from "@walter-sql/view";
import type {
  ClientMessage,
  RowValue,
  ServerMessage,
  Sink,
  StreamOptions,
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

interface Sub<TRow extends RowValue = any> {
  shapeId: string;
  shape: EngineShape<TRow>;
  listener: (msg: ServerMessage<TRow>) => void;
}

export class EngineClient {
  private readonly ws: ReconnectingWebSocket;
  private readonly subs = new Map<string, Sub>();
  private readonly sinks = new Set<Sink<ViewMessage<any>>>();
  private readonly statusListeners = new Set<
    (status: ConnectionStatus) => void
  >();
  private seq = 0;
  private closed = false;

  constructor(url: string, options: EngineClientOptions = {}) {
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
    options?: StreamOptions
  ): AsyncIterable<ViewMessage<TRow>> {
    return subscriptionStream<TRow>(sink => {
      if (this.closed) {
        sink.complete();
        return () => {};
      }
      this.sinks.add(sink);
      const off = this.subscribe<TRow>(shape, msg => {
        if (msg.type === "error")
          sink.error(new WalterError(msg.code, { cause: msg.message }));
        else sink.next(msg);
      });
      return () => {
        this.sinks.delete(sink);
        off();
      };
    }, options);
  }

  snapshot<TRow extends RowValue = RowValue>(
    shape: EngineShape<TRow>
  ): Promise<TRow[]> {
    return snapshot(this.stream(shape));
  }

  response(shape: EngineShape, options?: SseOptions): Response {
    return sseResponse(signal => this.stream(shape, { signal }), options);
  }

  pipe(
    shape: EngineShape,
    res: ServerResponse,
    options?: SseOptions
  ): Promise<void> {
    return pipeSSE(res, signal => this.stream(shape, { signal }), options);
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
    this.closed = true;
    this.subs.clear();
    this.ws.close();
    for (const sink of this.sinks) sink.complete();
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
