import type { IncomingMessage } from "node:http";
import { EngineClient } from "@walter-sql/client";
import {
  applyView,
  pendingView,
  type ErrorMsg,
  type ServerMessage,
  type View
} from "@walter-sql/view";
import { SqlParseError, UnsupportedSqlError } from "../parser/ir";
import type { ShapeRequest, SubscriptionManager } from "./manager";
import type { ViewSubscriber } from "./shape";
import { GraceMap } from "../util/grace";
import { log } from "../util/log";

export interface ShapeSubscriber extends ViewSubscriber {
  error(err: Error, code: ErrorMsg["code"]): void;
}

export const INSTANCE_HEADER = "x-walter-instance";

export const shapeKey = (req: ShapeRequest): string =>
  `${req.sql}\u0000${JSON.stringify(req.params)}`;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

export function ownerOf(key: string, peers: readonly string[]): string {
  let owner = "";
  let best = -1;
  for (const p of peers) {
    const score = fnv1a(`${p}\u0000${key}`);
    if (score > best || (score === best && p < owner)) {
      owner = p;
      best = score;
    }
  }
  return owner;
}

class RelayShape {
  readonly subscribers = new Map<string, ShapeSubscriber>();
  private view: View = pendingView;
  off = (): void => {};

  constructor(private readonly drop: () => void) {}

  onMessage(msg: ServerMessage): void {
    if (msg.type === "error") {
      const err = new Error(msg.message);
      for (const sub of this.subscribers.values()) sub.error(err, msg.code);
      this.drop();
      return;
    }
    this.view = applyView(this.view, msg);
    switch (msg.type) {
      case "snapshot": {
        const rows = JSON.stringify(msg.rows);
        for (const sub of this.subscribers.values()) sub.snapshot(rows);
        break;
      }
      case "diff": {
        const changes = JSON.stringify(msg.changes);
        for (const sub of this.subscribers.values()) sub.diff(changes);
        break;
      }
      case "failed":
        for (const sub of this.subscribers.values()) sub.failed();
    }
  }

  greet(sub: ShapeSubscriber): void {
    if (this.view.status === "failed") sub.failed();
    else if (this.view.status === "live")
      sub.snapshot(JSON.stringify(this.view.rows));
  }
}

export class ShapeRouter {
  private readonly relays = new Map<string, RelayShape>();
  private readonly links = new Map<string, Promise<"local" | EngineClient>>();
  private readonly clients = new Set<EngineClient>();
  private readonly rejected = new Set<string>();
  private readonly grace: GraceMap;

  constructor(
    private readonly manager: SubscriptionManager | undefined,
    private readonly peers: readonly string[],
    readonly instanceId: string,
    private readonly secret: string | undefined,
    graceTtlMs: number
  ) {
    this.grace = new GraceMap(graceTtlMs);
  }

  subscribe(
    sub: ShapeSubscriber,
    req: ShapeRequest,
    fromPeer: boolean
  ): () => void {
    const attached = this.attach(sub, req, fromPeer);
    return () => void attached.then(detach => detach());
  }

  private async attach(
    sub: ShapeSubscriber,
    req: ShapeRequest,
    fromPeer: boolean
  ): Promise<() => void> {
    try {
      if (!fromPeer && this.peers.length > 0) {
        const link = await this.resolve(ownerOf(shapeKey(req), this.peers));
        if (link !== "local") return this.attachRelay(link, req, sub);
      }
      return await this.attachLocal(sub, req);
    } catch (e) {
      const err = e as Error;
      const code: ErrorMsg["code"] =
        err instanceof SqlParseError
          ? "parse_error"
          : err instanceof UnsupportedSqlError
            ? "unsupported_sql"
            : "internal";
      sub.error(err, code);
      return () => {};
    }
  }

  private async attachLocal(
    sub: ShapeSubscriber,
    req: ShapeRequest
  ): Promise<() => void> {
    const manager = this.manager;
    if (!manager)
      throw new Error("this node has no WALTER_PG and cannot maintain shapes");
    const shape = await manager.subscribe(sub, req);
    return () => manager.unsubscribe(shape, sub.id);
  }

  private attachRelay(
    link: EngineClient,
    req: ShapeRequest,
    sub: ShapeSubscriber
  ): () => void {
    const key = shapeKey(req);
    let shape = this.relays.get(key);
    if (!shape) {
      const created = new RelayShape(() => this.dropRelay(key, created));
      created.off = link.subscribe({ sql: req.sql, params: req.params }, msg =>
        created.onMessage(msg)
      );
      this.relays.set(key, created);
      shape = created;
    }
    this.grace.cancel(key);
    shape.subscribers.set(sub.id, sub);
    shape.greet(sub);
    return () => {
      shape.subscribers.delete(sub.id);
      if (shape.subscribers.size === 0 && this.relays.get(key) === shape) {
        this.grace.schedule(key, () => {
          if (shape.subscribers.size === 0) this.dropRelay(key, shape);
        });
      }
    };
  }

  private dropRelay(key: string, shape: RelayShape): void {
    if (this.relays.get(key) === shape) this.relays.delete(key);
    this.grace.cancel(key);
    shape.off();
  }

  private resolve(entry: string): Promise<"local" | EngineClient> {
    let link = this.links.get(entry);
    if (!link) {
      link = this.dial(entry);
      this.links.set(entry, link);
    }
    return link;
  }

  private dial(entry: string): Promise<"local" | EngineClient> {
    return new Promise(resolve => {
      let settled = false;
      const client = new EngineClient(entry, {
        secret: this.secret,
        headers: { [INSTANCE_HEADER]: this.instanceId },
        onUpgrade: (res: IncomingMessage) => {
          if (!settled && res.headers[INSTANCE_HEADER] === this.instanceId) {
            settled = true;
            client.close();
            resolve("local");
          }
        },
        onHandshakeRejected: status => {
          if (status === 401 && !this.rejected.has(entry)) {
            this.rejected.add(entry);
            log.warn(
              { peer: entry },
              "peer rejected the handshake: WALTER_SECRET mismatch"
            );
          }
        }
      });
      this.clients.add(client);
      client.onStatusChange(status => {
        if (status === "open" && !settled) {
          settled = true;
          resolve(client);
        }
      });
    });
  }

  get stats() {
    let relaySubscribers = 0;
    for (const s of this.relays.values())
      relaySubscribers += s.subscribers.size;
    return { relayShapes: this.relays.size, relaySubscribers };
  }

  dispose(): void {
    this.grace.clear();
    for (const client of this.clients) client.close();
    this.relays.clear();
  }
}
