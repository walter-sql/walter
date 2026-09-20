import WebSocket from "ws";
import type { IncomingMessage } from "node:http";

export interface ReconnectOptions {
  headers?: Record<string, string>;
  maxReconnectionDelay?: number;
  minReconnectionDelay?: number;
  connectionTimeout?: number;
  onUpgrade?: (res: IncomingMessage) => void;
  onHandshakeRejected?: (statusCode: number) => void;
}

type SocketEvent = keyof WebSocket.WebSocketEventMap;
type SocketListener = (event: { type: string; data?: unknown }) => void;

export class ReconnectingWebSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  private retries = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly headers?: Record<string, string>;
  private readonly maxDelay: number;
  private readonly minDelay: number;
  private readonly connectionTimeout: number;
  private readonly onUpgrade?: (res: IncomingMessage) => void;
  private readonly onHandshakeRejected?: (statusCode: number) => void;

  constructor(
    private readonly url: string,
    options: ReconnectOptions = {}
  ) {
    this.headers = options.headers;
    this.maxDelay = options.maxReconnectionDelay ?? 5000;
    this.minDelay = options.minReconnectionDelay ?? 250;
    this.connectionTimeout = options.connectionTimeout ?? 4000;
    this.onUpgrade = options.onUpgrade;
    this.onHandshakeRejected = options.onHandshakeRejected;
    this.open();
  }

  get readyState(): number {
    return this.socket?.readyState ?? 3;
  }

  send(data: string): void {
    if (this.socket?.readyState === 1) this.socket.send(data);
  }

  addEventListener(type: SocketEvent, listener: SocketListener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    this.socket?.addEventListener(type, listener);
  }

  removeEventListener(type: SocketEvent, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
    this.socket?.removeEventListener(type, listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.socket?.close();
  }

  private open(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url, {
      headers: this.headers
    });
    this.socket = socket;

    this.connectTimer = setTimeout(
      () => socket.close(),
      this.connectionTimeout
    );

    socket.addEventListener("open", () => {
      this.retries = 0;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
    });
    socket.addEventListener("close", () => this.reconnect());
    socket.addEventListener("error", () => socket.close());
    if (this.onUpgrade) socket.on("upgrade", this.onUpgrade);
    socket.on("unexpected-response", (_req, res) => {
      this.onHandshakeRejected?.(res.statusCode ?? 0);
      res.resume();
      socket.terminate();
      this.reconnect();
    });

    for (const [type, set] of this.listeners) {
      for (const listener of set) socket.addEventListener(type, listener);
    }
  }

  private reconnect(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
