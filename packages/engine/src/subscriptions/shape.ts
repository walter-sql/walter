import type { ShapeTreePlan } from "../planner/plan";
import type { TxnBatch } from "../cdc/types";
import type { TreeMaterializer } from "./materializer";
import type { LazyTree } from "../lazy/lazy-tree";
import { Stream } from "../lazy/stream";
import { createSerialQueue } from "../util/serial-queue";
import { log } from "../util/log";

export interface ViewSubscriber {
  readonly id: string;
  snapshot(rows: string): void;
  diff(changes: string): void;
  failed(): void;
}

interface Queued {
  batch: TxnBatch;
  done: () => void;
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

export class ShapeRuntime {
  readonly subscribers = new Map<string, ViewSubscriber>();
  private readonly enqueue = createSerialQueue();
  readonly seeded: Promise<void>;
  failedBy?: Error;
  private lazy?: LazyTree;
  private inbox: Queued[] = [];
  private unacked: Queued[] = [];
  private drainDone?: Promise<void>;
  private applied: bigint;
  private armed?: bigint;
  private nudge?: () => void;
  private replaced = false;
  private retryDelay = 0;
  private retryTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    readonly fingerprint: string,
    readonly sql: string,
    readonly compiled: ShapeTreePlan,
    private readonly makeTree: (applied: bigint) => LazyTree,
    private readonly stream = new Stream()
  ) {
    this.applied = stream.position;
    this.seeded = this.rebuild();
  }

  get materializer(): TreeMaterializer {
    return this.lazy!.materializer;
  }

  get tables(): string[] {
    return this.compiled.tables;
  }

  get workingSetSize(): number {
    return this.lazy?.workingSetSize ?? 0;
  }

  ingest(batch: TxnBatch): Promise<void> {
    const applied = new Promise<void>(done => this.inbox.push({ batch, done }));
    this.nudge?.();
    this.drainDone ??= this.enqueue(() => this.drain()).catch(err =>
      this.fail(err as Error)
    );
    return applied;
  }

  private async drain(): Promise<void> {
    this.drainDone = undefined;
    if (this.failedBy || this.disposed) return this.drop();
    while (this.inbox.length > 0) {
      await this.absorb(this.take());
      await this.settle();
      this.send();
    }
  }

  private take(upTo?: bigint): Queued[] {
    const n =
      upTo === undefined
        ? -1
        : this.inbox.findIndex(q => q.batch.position > upTo);
    return this.inbox.splice(0, n < 0 ? this.inbox.length : n);
  }

  private drop(): void {
    for (const q of this.inbox.splice(0)) {
      this.applied = q.batch.position;
      this.unacked.push(q);
    }
    this.ack();
  }

  private ack(): void {
    for (const q of this.unacked.splice(0)) q.done();
  }

  private async absorb(taken: Queued[]): Promise<void> {
    if (taken.length === 0) return;
    this.unacked.push(...taken);
    const batches = taken.map(q => q.batch);
    this.applied = batches.at(-1)!.position;
    if (batches.some(b => b.truncated?.some(t => this.tables.includes(t))))
      return this.reseed();
    await this.lazy!.absorb({
      ops: batches.flatMap(b => b.ops),
      position: this.applied
    });
  }

  private async settle(): Promise<void> {
    let target = await this.lazy!.fence();
    while (target !== undefined) {
      const taken = this.take(target);
      if (taken.length > 0) await this.absorb(taken);
      else if (this.stream.position >= target)
        target = await this.lazy!.fence();
      else {
        this.ack();
        await this.nudged(target);
      }
    }
  }

  private nudged(target: bigint): Promise<void> {
    if (this.armed !== target) {
      this.armed = target;
      void this.stream.reached(target).then(() => this.nudge?.());
    }
    return new Promise(resolve => (this.nudge = resolve));
  }

  private send(): void {
    const changes = this.lazy!.flush();
    if (this.replaced) {
      this.replaced = false;
      if (this.failedBy) {
        this.failedBy = undefined;
        this.retryDelay = 0;
        log.info({ shape: this.fingerprint }, "shape recovered");
      }
      const json = JSON.stringify(this.materializer.snapshot());
      for (const sub of this.subscribers.values()) sub.snapshot(json);
    } else if (changes.length > 0) {
      const json = JSON.stringify(changes);
      for (const sub of this.subscribers.values()) sub.diff(json);
    }
    this.ack();
  }

  reset(): Promise<void> {
    if (this.failedBy) return Promise.resolve();
    return this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private fail(err: Error): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const entering = this.failedBy === undefined;
    this.failedBy = err;
    this.lazy = undefined;
    this.drop();
    this.retryDelay =
      this.retryDelay === 0
        ? MIN_RETRY_MS
        : Math.min(MAX_RETRY_MS, this.retryDelay * 2);
    log.warn(
      { shape: this.fingerprint, sql: this.sql, retryMs: this.retryDelay, err },
      "shape failed"
    );
    if (!this.disposed) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.rebuild();
      }, this.retryDelay);
      this.retryTimer.unref?.();
    }
    if (entering) for (const sub of this.subscribers.values()) sub.failed();
  }

  private rebuild(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      await this.reseed();
      await this.settle();
      this.send();
    }).catch(err => this.fail(err as Error));
  }

  private async reseed(): Promise<void> {
    const fresh = this.makeTree(this.applied);
    await fresh.load();
    this.lazy = fresh;
    this.replaced = true;
  }

  addSubscriber(sub: ViewSubscriber): void {
    this.subscribers.set(sub.id, sub);
    if (this.failedBy) sub.failed();
    else if (!this.replaced)
      sub.snapshot(JSON.stringify(this.materializer.snapshot()));
  }

  removeSubscriber(id: string): void {
    this.subscribers.delete(id);
  }
}
