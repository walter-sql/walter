import { parseShapeSql } from "../parser/parse";
import { planShape } from "../planner/plan";
import { shapeFingerprint } from "../planner/hash";
import type { TxnBatch } from "../cdc/types";
import type { RowSource } from "../lazy/rowsource";
import { LazyTree } from "../lazy/lazy-tree";
import type { Stream } from "../lazy/stream";
import type { SchemaCatalog } from "../parser/catalog";
import { ShapeRuntime, type ViewSubscriber } from "./shape";
import { GraceMap } from "../util/grace";
import { log } from "../util/log";

export interface ShapeRequest {
  sql: string;
  params: unknown[];
}

export const MAX_QUEUED_OPS = 10_000;

export class SubscriptionManager {
  private readonly shapes = new Map<string, ShapeRuntime>();
  private readonly tableIndex = new Map<string, Set<ShapeRuntime>>();
  private readonly grace: GraceMap;
  private queuedOps = 0;
  private waiters: { atMost: number; resolve: () => void }[] = [];
  private seeds = 0;
  private seedMs = 0;
  private reseeds = 0;

  constructor(
    private readonly rowSource: RowSource,
    private readonly catalog: SchemaCatalog,
    private readonly defaultSchema: string,
    graceTtlMs: number,
    private readonly stream?: Stream
  ) {
    this.grace = new GraceMap(graceTtlMs);
  }

  private async getOrCreate(req: ShapeRequest): Promise<ShapeRuntime> {
    const shape = await parseShapeSql(
      req.sql,
      this.catalog,
      this.defaultSchema
    );
    const fp = shapeFingerprint(shape, req.params);
    const existing = this.shapes.get(fp);
    if (existing) return existing;

    const compiled = planShape(shape, req.params, this.catalog);
    const runtime = new ShapeRuntime(
      fp,
      req.sql,
      compiled,
      applied =>
        new LazyTree(
          compiled,
          req.params,
          this.rowSource,
          applied,
          this.stream
        ),
      this.stream
    );
    this.shapes.set(fp, runtime);
    for (const table of compiled.tables) {
      let set = this.tableIndex.get(table);
      if (!set) this.tableIndex.set(table, (set = new Set()));
      set.add(runtime);
    }
    const t0 = Date.now();
    void runtime.seeded.then(() => {
      if (runtime.failedBy) return;
      const ms = Date.now() - t0;
      this.seeds++;
      this.seedMs += ms;
      log.info(
        {
          shape: fp,
          tables: compiled.tables,
          rows: runtime.workingSetSize,
          ms
        },
        "shape seeded"
      );
    });
    return runtime;
  }

  async subscribe(
    sub: ViewSubscriber,
    req: ShapeRequest
  ): Promise<ShapeRuntime> {
    const shape = await this.getOrCreate(req);
    this.grace.cancel(shape.fingerprint);
    await shape.seeded;
    shape.addSubscriber(sub);
    return shape;
  }

  unsubscribe(shape: ShapeRuntime, subId: string): void {
    shape.removeSubscriber(subId);
    if (shape.subscribers.size !== 0) return;
    this.grace.schedule(shape.fingerprint, () => {
      if (shape.subscribers.size === 0) this.dropShape(shape);
    });
  }

  private dropShape(shape: ShapeRuntime): void {
    log.info({ shape: shape.fingerprint }, "shape torn down (idle)");
    shape.dispose();
    this.grace.cancel(shape.fingerprint);
    if (this.shapes.get(shape.fingerprint) === shape)
      this.shapes.delete(shape.fingerprint);
    for (const table of shape.tables) this.tableIndex.get(table)?.delete(shape);
  }

  resetAll(): void {
    for (const s of this.shapes.values()) {
      if (!s.failedBy) this.reseeds++;
      void s.reset();
    }
  }

  handleTxn(batch: TxnBatch): Promise<void> {
    const affected = new Set<ShapeRuntime>();
    const add = (table: string) => {
      const set = this.tableIndex.get(table);
      if (set) for (const s of set) affected.add(s);
    };
    for (const op of batch.ops) add(op.table);
    if (batch.truncated) {
      const hit = new Set<ShapeRuntime>();
      for (const table of batch.truncated) {
        const set = this.tableIndex.get(table);
        if (set) for (const s of set) hit.add(s);
      }
      for (const s of hit) {
        if (!s.failedBy) this.reseeds++;
        affected.add(s);
      }
    }
    const units = batch.ops.length || 1;
    for (const shape of affected) {
      this.queuedOps += units;
      void shape.ingest(batch).then(() => this.drained(units));
    }
    this.stream?.received(batch);
    return this.whenAtMost(MAX_QUEUED_OPS);
  }

  settled(): Promise<void> {
    return this.whenAtMost(0);
  }

  private drained(n: number): void {
    this.queuedOps -= n;
    this.waiters = this.waiters.filter(w => {
      if (this.queuedOps > w.atMost) return true;
      w.resolve();
      return false;
    });
  }

  private whenAtMost(n: number): Promise<void> {
    if (this.queuedOps <= n) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ atMost: n, resolve }));
  }

  get stats() {
    let subscribers = 0;
    let workingSet = 0;
    let failedShapes = 0;
    for (const s of this.shapes.values()) {
      subscribers += s.subscribers.size;
      workingSet += s.workingSetSize;
      if (s.failedBy) failedShapes++;
    }
    return {
      shapes: this.shapes.size,
      failedShapes,
      subscribers,
      workingSet,
      backlog: this.queuedOps,
      seeds: this.seeds,
      seedMs: this.seedMs,
      reseeds: this.reseeds
    };
  }
}
