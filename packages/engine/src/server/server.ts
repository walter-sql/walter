import { WebSocketServer, type WebSocket } from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { ClientMessage, ErrorMsg } from "@walter-sql/view";
import {
  INSTANCE_HEADER,
  type ShapeRouter,
  type ShapeSubscriber
} from "../subscriptions/cluster";
import { Sender } from "./sender";
import {
  diffFrame,
  encodeServerMessage,
  parseClientMessage,
  snapshotFrame
} from "./wire";
import { log } from "../util/log";

export interface ServerHealth {
  ready(): boolean;
  metrics(): string;
}

export class WalterServer {
  private wss?: WebSocketServer;
  private http?: Server;
  private pinger?: NodeJS.Timeout;
  private readonly alive = new Set<WebSocket>();
  private readonly senders = new Set<Sender>();

  constructor(
    private readonly router: ShapeRouter,
    private readonly port: number,
    private readonly host: string,
    private readonly secret?: string,
    private readonly health?: ServerHealth,
    private readonly heartbeatMs = 30_000
  ) {}

  get url() {
    return `ws://${this.host}:${this.port}`;
  }

  get senderStats() {
    let frames = 0;
    let buffered = 0;
    for (const s of this.senders) frames += s.depth;
    for (const ws of this.wss?.clients ?? []) buffered += ws.bufferedAmount;
    return { sendQueue: frames, sendBuffered: buffered };
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => this.onRequest(req, res));
      const wss = new WebSocketServer({
        server: http,
        verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
          !info.origin && this.authorized(info.req)
      });
      this.http = http;
      this.wss = wss;
      wss.on("headers", headers =>
        headers.push(`${INSTANCE_HEADER}: ${this.router.instanceId}`)
      );
      wss.on("connection", (ws, req) => this.onConnection(ws, req));
      wss.on("error", reject);
      http.listen(this.port, this.host, () => {
        this.pinger = setInterval(() => {
          for (const ws of wss.clients) {
            if (this.alive.delete(ws)) ws.ping();
            else ws.terminate();
          }
        }, this.heartbeatMs);
        this.pinger.unref?.();
        resolve();
      });
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    switch (req.url?.split("?")[0]) {
      case "/live":
        res.writeHead(200).end();
        return;
      case "/ready":
        res.writeHead((this.health?.ready() ?? true) ? 200 : 503).end();
        return;
      case "/metrics":
        if (!this.authorized(req)) {
          res.writeHead(401).end();
          return;
        }
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(this.health?.metrics() ?? "");
        return;
      default:
        res.writeHead(404).end();
    }
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.secret) return true;
    const header = req.headers.authorization;
    if (!header) return false;
    return timingSafeEqual(digest(header), digest(`Bearer ${this.secret}`));
  }

  async close(): Promise<void> {
    const { wss, http } = this;
    if (!wss || !http) return;
    clearInterval(this.pinger);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = `c${++connSeq}`;
    const fromPeer = req.headers[INSTANCE_HEADER] !== undefined;
    log.info({ conn: connId, fromPeer }, "connection open");
    const sender = new Sender(ws);
    this.senders.add(sender);
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    const subs = new Map<string, () => void>();

    const sendError = (e: Omit<ErrorMsg, "type">) =>
      sender.send(encodeServerMessage({ type: "error", ...e }));

    const makeSubscriber = (shapeId: string): ShapeSubscriber => ({
      id: `s${++subSeq}`,
      snapshot: rows => sender.send(snapshotFrame(shapeId, rows)),
      diff: changes => sender.send(diffFrame(shapeId, changes)),
      failed: () =>
        sender.send(encodeServerMessage({ type: "failed", shapeId })),
      error: (err, code) => {
        subs.delete(shapeId);
        sendError({ shapeId, code, message: err.message });
      }
    });

    const handle = (msg: ClientMessage): void => {
      switch (msg.type) {
        case "subscribe": {
          if (subs.has(msg.shapeId)) {
            sendError({
              shapeId: msg.shapeId,
              code: "bad_message",
              message: "shapeId already subscribed"
            });
            return;
          }
          const off = this.router.subscribe(
            makeSubscriber(msg.shapeId),
            { sql: msg.sql, params: msg.params ?? [] },
            fromPeer
          );
          subs.set(msg.shapeId, off);
          break;
        }
        case "unsubscribe": {
          const off = subs.get(msg.shapeId);
          if (off) {
            subs.delete(msg.shapeId);
            off();
          }
          break;
        }
      }
    };

    ws.on("message", raw => {
      const parsed = parseClientMessage(raw.toString());
      if (!parsed.ok) {
        sendError({ code: "bad_message", message: parsed.error });
        return;
      }
      handle(parsed.msg);
    });

    ws.on("close", () => {
      this.alive.delete(ws);
      for (const off of subs.values()) off();
      subs.clear();
      sender.dispose();
      this.senders.delete(sender);
      log.info({ conn: connId }, "connection closed");
    });

    ws.on("error", () => {});
  }
}

let connSeq = 0;
let subSeq = 0;

const digest = (s: string) => createHash("sha256").update(s).digest();
