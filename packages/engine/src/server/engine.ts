import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { CdcSource } from "../cdc/replication";
import { SubscriptionManager } from "../subscriptions/manager";
import { ShapeRouter } from "../subscriptions/cluster";
import { PgRowSource, pinnedPool } from "../lazy/pg-source";
import { BatchingRowSource } from "../lazy/batching-source";
import { Stream } from "../lazy/stream";
import { parseLsn } from "../lazy/snapshot";
import { SchemaCatalog } from "../parser/catalog";
import { WalterServer } from "./server";
import { initParser } from "../parser/parse";
import { log } from "../util/log";

export interface WalterConfig {
  pg?: string;
  port?: number;
  host?: string;
  secret?: string;
  defaultSchema?: string;
  graceTtlMs?: number;
  tables?: string[];
  peers?: string[];
}

export class WalterEngine {
  readonly catalog?: SchemaCatalog;
  readonly manager?: SubscriptionManager;
  readonly cdc?: CdcSource;
  readonly router: ShapeRouter;
  readonly server: WalterServer;
  private readonly pool?: Pool;
  private readonly stream = new Stream();
  private pulse?: NodeJS.Timeout;

  constructor(config: WalterConfig) {
    const {
      pg,
      port = 5544,
      host = "127.0.0.1",
      secret,
      defaultSchema = "public",
      graceTtlMs = 30_000,
      tables,
      peers = []
    } = config;

    if (!pg && peers.length === 0) {
      throw new Error(
        "config needs pg (maintain shapes) and/or peers (relay them)"
      );
    }
    if (pg) {
      this.catalog = new SchemaCatalog();
      this.pool = pinnedPool({ connectionString: pg });
      const rowSource = new BatchingRowSource(
        new PgRowSource(this.pool, {
          defaultSchema,
          catalog: this.catalog,
          stream: this.stream
        }),
        this.catalog
      );
      this.manager = new SubscriptionManager(
        rowSource,
        this.catalog,
        defaultSchema,
        graceTtlMs,
        this.stream
      );
      this.cdc = new CdcSource(pg, this.catalog, tables, defaultSchema);
    }
    this.router = new ShapeRouter(
      this.manager,
      peers,
      randomBytes(9).toString("base64url"),
      secret,
      graceTtlMs
    );
    this.server = new WalterServer(this.router, port, host, secret, {
      ready: () => !(this.cdc?.degraded ?? false),
      metrics: () => renderMetrics(this.stats)
    });
  }

  get stats() {
    return {
      ...(this.manager?.stats ?? {
        shapes: 0,
        failedShapes: 0,
        subscribers: 0,
        workingSet: 0,
        backlog: 0,
        seeds: 0,
        seedMs: 0,
        reseeds: 0
      }),
      ...this.router.stats,
      ...(this.cdc?.stats ?? { connected: undefined, lastActivity: undefined }),
      ...this.server.senderStats,
      rss: process.memoryUsage.rss()
    };
  }

  async start(): Promise<void> {
    let lsn: string | undefined;
    if (this.cdc) {
      await initParser();
      await this.cdc.setup();
      lsn = await this.cdc.start(
        batch => this.manager!.handleTxn(batch),
        slot => {
          this.stream.advance(parseLsn(slot));
          this.manager!.resetAll();
        }
      );
    }
    await this.server.listen();
    log.info({ url: this.server.url, lsn }, "listening");

    this.pulse = setInterval(() => log.info(this.stats, "pulse"), 60_000);
    this.pulse.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.pulse);
    await this.cdc?.stop();
    await this.server.close();
    this.router.dispose();
    await this.pool?.end();
    log.info("stopped");
  }
}

function renderMetrics(s: WalterEngine["stats"]): string {
  const lines: string[] = [];
  const emit = (name: string, type: string, value: number) =>
    lines.push(`# TYPE ${name} ${type}`, `${name} ${value}`);
  if (s.connected !== undefined) {
    emit("walter_replication_connected", "gauge", s.connected ? 1 : 0);
    emit(
      "walter_stream_activity_timestamp_seconds",
      "gauge",
      (s.lastActivity ?? 0) / 1000
    );
  }
  emit("walter_shapes", "gauge", s.shapes);
  emit("walter_shapes_failed", "gauge", s.failedShapes);
  emit("walter_subscribers", "gauge", s.subscribers);
  emit("walter_relay_shapes", "gauge", s.relayShapes);
  emit("walter_relay_subscribers", "gauge", s.relaySubscribers);
  emit("walter_working_set_rows", "gauge", s.workingSet);
  emit("walter_backlog_ops", "gauge", s.backlog);
  emit("walter_send_queue_frames", "gauge", s.sendQueue);
  emit("walter_send_buffered_bytes", "gauge", s.sendBuffered);
  emit("walter_seeds_total", "counter", s.seeds);
  emit("walter_seed_seconds_total", "counter", s.seedMs / 1000);
  emit("walter_reseeds_total", "counter", s.reseeds);
  emit("process_resident_memory_bytes", "gauge", s.rss);
  return lines.join("\n") + "\n";
}
