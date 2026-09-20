import {
  compileRowPredicate,
  type CompiledPredicate
} from "../planner/compile";
import {
  emptyZSet,
  stableStringify,
  zsetAddRow,
  zsetMergeInto,
  type Row,
  type ZSet
} from "../ivm/zset";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppliedOps, ChangeOp } from "../cdc/types";
import type { CollectionOp } from "@walter-sql/view";
import type { CompiledWindow, LevelPlan, ShapeTreePlan } from "../planner/plan";
import { TreeMaterializer } from "../subscriptions/materializer";
import { compareSortKeys, identityKey, isNull } from "../parser/eval";
import {
  corrValue,
  type RowSource,
  type SourcedRows,
  type WindowPartition,
  type WindowRequest
} from "./rowsource";
import { absorbed, type PgSnapshot } from "./snapshot";
import { WorkingSetStore } from "./store";
import type { Stream } from "./stream";
import type { LazyPlan, LazySource } from "./analyze";
import {
  compareAnchorPrefix,
  revealTargets,
  wcol,
  windowTuple,
  type PartnerTrigger,
  type Reveal,
  type RevealGroup,
  type WindowSpec
} from "./window";

interface Ref {
  value: readonly unknown[];
  count: number;
}

interface PartCursor {
  after: readonly unknown[] | undefined;
  exhausted: boolean;
}

class RevealAcc {
  private readonly byTrig = new Map<PartnerTrigger, Map<string, unknown[]>>();

  add(trig: PartnerTrigger, op: ChangeOp): void {
    const t = revealTargets(trig, op);
    if (t === undefined) return;
    let m = this.byTrig.get(trig);
    if (!m) this.byTrig.set(trig, (m = new Map()));
    for (const tuple of t) m.set(stableStringify(tuple), [...tuple]);
  }

  get(): Reveal | undefined {
    if (this.byTrig.size === 0) return undefined;
    const groups: RevealGroup[] = [];
    for (const [trig, m] of this.byTrig) {
      groups.push({
        columns: trig.pairs.map(p => ({ alias: p.alias, column: p.column })),
        tuples: [...m.values()]
      });
    }
    return groups;
  }
}

const MAX_RETRY_MS = 250;

export class LazyTree {
  private readonly runtimes = new Map<LevelPlan, LevelRuntime>();
  private readonly rootRt: LevelRuntime;
  private readonly mat: TreeMaterializer;
  private pending = new Map<LevelPlan, ZSet>();
  private fetched = false;
  private readonly tables: readonly string[];

  constructor(
    plan: ShapeTreePlan,
    params: readonly unknown[],
    source: RowSource,
    private applied = 0n,
    private readonly stream?: Stream
  ) {
    this.tables = plan.tables;
    this.mat = new TreeMaterializer(plan);
    this.rootRt = this.buildRuntimes(plan.root, params, {
      scopedRows: (...a) => this.read(() => source.scopedRows(...a)),
      fetchWhereIn: (...a) => this.read(() => source.fetchWhereIn(...a)),
      fetchWindow: req => this.read(() => source.fetchWindow(req))
    });
  }

  private buildRuntimes(
    level: LevelPlan,
    params: readonly unknown[],
    rowSource: RowSource
  ): LevelRuntime {
    const rt = new LevelRuntime(level, params, rowSource);
    this.runtimes.set(level, rt);
    for (const c of level.collections)
      this.buildRuntimes(c.level, params, rowSource);
    return rt;
  }

  private async read(fetch: () => Promise<SourcedRows>): Promise<SourcedRows> {
    for (let wait = 1; ; wait = Math.min(wait * 2, MAX_RETRY_MS)) {
      const unseen = this.stream?.unseen(this.tables, this.applied) ?? [];
      const got = await fetch();
      if (unseen.every(xid => absorbed(got.snap, xid))) {
        this.fetched = true;
        return got;
      }
      await sleep(wait);
    }
  }

  async fence(): Promise<bigint | undefined> {
    if (!this.fetched) return undefined;
    this.fetched = false;
    return this.stream?.fence();
  }

  get materializer(): TreeMaterializer {
    return this.mat;
  }

  get workingSetSize(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) n += rt.workingSetSize;
    return n;
  }

  get edgeRefSize(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) n += rt.edgeRefSize;
    return n;
  }

  get window(): WindowSpec | undefined {
    return this.rootRt.window;
  }

  async load(): Promise<void> {
    this.rootRt.pull([], 1);
    this.hold(await this.run(undefined));
  }

  async absorb(batch: AppliedOps): Promise<void> {
    this.applied = batch.position;
    this.hold(await this.run(batch));
  }

  flush(): CollectionOp[] {
    const deltas = this.pending;
    this.pending = new Map();
    for (const z of deltas.values())
      if (z.size > 0) return this.mat.apply(deltas);
    return [];
  }

  private hold(deltas: Map<LevelPlan, ZSet>): void {
    for (const [level, z] of deltas) {
      const held = this.pending.get(level);
      if (held) zsetMergeInto(held, z);
      else this.pending.set(level, z);
    }
  }

  private async run(
    batch: AppliedOps | undefined
  ): Promise<Map<LevelPlan, ZSet>> {
    const deltas = new Map<LevelPlan, ZSet>();
    const visit = async (rt: LevelRuntime): Promise<void> => {
      const out = batch ? await rt.process(batch) : await rt.seed();
      deltas.set(rt.plan, out);
      for (const coll of rt.plan.collections) {
        const child = this.runtimes.get(coll.level)!;
        for (const { row, weight } of out.values())
          child.pull(corrValue(row, coll.parentKey), weight);
        await visit(child);
      }
    };
    await visit(this.rootRt);
    return deltas;
  }
}

class LevelRuntime {
  readonly plan: LevelPlan;
  private readonly params: readonly unknown[];
  private readonly rowSource: RowSource;
  private readonly sourcing: LazyPlan;
  private readonly store: WorkingSetStore;
  private readonly admit = new Map<string, CompiledPredicate<Row>>();
  private readonly refs: Map<string, Ref>[];
  private readonly born: Set<string>[];
  private readonly dead: Set<string>[];
  private readonly edgesByDim = new Map<string, number[]>();
  private readonly edgesByPuller = new Map<string, number[]>();
  private readonly anchor: number | undefined;

  private readonly win: CompiledWindow | undefined;
  private readonly cursors = new Map<string, PartCursor>();
  private readonly dirty = new Set<string>();
  private readonly suspects = new Map<string, Set<string>>();

  private deltas = new Map<string, ZSet>();

  constructor(
    plan: LevelPlan,
    params: readonly unknown[],
    rowSource: RowSource
  ) {
    this.plan = plan;
    this.params = params;
    this.rowSource = rowSource;
    const sourcing = plan.lazySourcing();
    this.sourcing = sourcing;
    this.store = new WorkingSetStore(
      new Map(sourcing.sources.map(s => [s.table, s.keyColumns]))
    );
    for (const s of sourcing.sources) {
      if (s.localPred)
        this.admit.set(s.table, compileRowPredicate(s.localPred, params));
    }
    this.win = plan.window;
    this.refs = sourcing.edges.map(() => new Map());
    this.born = sourcing.edges.map(() => new Set());
    this.dead = sourcing.edges.map(() => new Set());
    let anchor: number | undefined;
    sourcing.edges.forEach((e, i) => {
      let dims = this.edgesByDim.get(e.dimTable);
      if (!dims) this.edgesByDim.set(e.dimTable, (dims = []));
      dims.push(i);
      if (!e.puller) {
        anchor = i;
        return;
      }
      let pulls = this.edgesByPuller.get(e.puller.table);
      if (!pulls) this.edgesByPuller.set(e.puller.table, (pulls = []));
      pulls.push(i);
    });
    this.anchor = anchor;
  }

  get workingSetSize(): number {
    return this.store.totalSize;
  }

  get edgeRefSize(): number {
    let n = 0;
    for (const m of this.refs) n += m.size;
    return n;
  }

  get window(): WindowSpec | undefined {
    return this.win?.spec;
  }

  pull(value: readonly unknown[], weight: number): void {
    if (this.anchor !== undefined) this.ref(this.anchor, value, weight);
  }

  async seed(): Promise<ZSet> {
    this.begin();
    for (const s of this.sourcing.sources)
      if (!s.isDim) await this.fetchAnchorRows(s);
    return this.complete(undefined);
  }

  async process(batch: AppliedOps): Promise<ZSet> {
    this.begin();
    const reveal = new RevealAcc();
    for (const op of batch.ops) {
      const src = this.sourcing.byTable.get(op.table);
      if (!src) continue;
      for (const trig of this.win?.spec.partnerTriggers ?? [])
        if (trig.table === op.table) reveal.add(trig, op);
      this.applyTableOp(op, src);
    }
    return this.complete(reveal.get());
  }

  private begin(): void {
    this.deltas = new Map();
    this.dirty.clear();
    this.suspects.clear();
  }

  private async complete(reveal: Reveal | undefined): Promise<ZSet> {
    await this.closure();
    let out = this.step();
    if (this.win) out = await this.reconcileWindows(out, reveal);
    return this.finish(out);
  }

  private mark(key: string, pk?: string): void {
    this.dirty.add(key);
    if (pk === undefined) return;
    let s = this.suspects.get(key);
    if (!s) this.suspects.set(key, (s = new Set()));
    s.add(pk);
  }

  private windowRequest(partitions: WindowPartition[]): WindowRequest {
    return {
      ...this.win!.spec,
      correlationColumns: this.sourcing.edges[this.anchor!]!.dimCols,
      partitions,
      params: this.params
    };
  }

  private async reconcileWindows(
    out: ZSet,
    reveal: Reveal | undefined
  ): Promise<ZSet> {
    const w = this.win!;
    const partitions = this.refs[this.anchor!]!;

    if (reveal !== undefined) {
      const parts: WindowPartition[] = [];
      for (const [key, { value }] of partitions) {
        const cur = this.cursors.get(key);
        if (!cur) continue;
        parts.push(cur.exhausted ? { value } : { value, after: cur.after });
      }
      if (parts.length > 0) {
        const { snap, rows } = await this.rowSource.fetchWindow({
          ...this.windowRequest(parts),
          reveal
        });
        this.admitFetched(rows, snap);
        await this.closure();
        out = zsetMergeInto(out, this.step());
      }
    }

    const cand = new Map<string, readonly unknown[]>();
    for (;;) {
      for (const key of this.dirty) {
        const r = partitions.get(key);
        if (r) cand.set(key, r.value);
      }
      this.dirty.clear();

      const depleted: { key: string; value: readonly unknown[] }[] = [];
      for (const [key, value] of cand) {
        const cur = this.cursors.get(key);
        if (cur?.exhausted) continue;
        if (!cur || this.availableRows(key) < w.spec.windowSize)
          depleted.push({ key, value });
      }
      if (depleted.length === 0) break;

      const { snap, rows } = await this.rowSource.fetchWindow(
        this.windowRequest(
          depleted.map(d => ({
            value: d.value,
            after: this.cursors.get(d.key)?.after
          }))
        )
      );

      const { got, last } = this.admitFetched(rows, snap);
      for (const { key } of depleted) {
        const n = got.get(key) ?? 0;
        const cur = this.cursors.get(key) ?? {
          after: undefined,
          exhausted: false
        };
        const tuple = last.get(key);
        if (tuple) cur.after = tuple;
        cur.exhausted = n < w.spec.pageSize;
        this.cursors.set(key, cur);
      }

      await this.closure();
      out = zsetMergeInto(out, this.step());
    }

    if (this.settle(cand)) {
      out = zsetMergeInto(out, this.step());
    }
    return out;
  }

  private admitFetched(
    rows: Row[],
    snap: PgSnapshot
  ): { got: Map<string, number>; last: Map<string, readonly unknown[]> } {
    const w = this.win!;
    const got = new Map<string, number>();
    const last = new Map<string, readonly unknown[]>();
    for (const row of rows) {
      const tuple = windowTuple(row, w.spec.order);
      for (let i = 0; i < w.spec.order.length; i++)
        if (!w.spec.order[i]!.anchor) delete row[wcol(i)];
      const key = this.partKeyOf(row);
      got.set(key, (got.get(key) ?? 0) + 1);
      const prev = last.get(key);
      if (!prev || compareSortKeys(tuple, prev, w.spec.order) > 0)
        last.set(key, tuple);
      const pk = this.store.pkOf(w.spec.anchorTable, row);
      if (this.store.has(w.spec.anchorTable, pk)) continue;
      this.store.set(w.spec.anchorTable, pk, row, snap);
      this.emit(w.spec.anchorTable, row, 1);
    }
    return { got, last };
  }

  private availableRows(key: string): number {
    const w = this.win!;
    const cur = this.cursors.get(key);
    if (!cur) return 0;
    let n = 0;
    for (const e of w.topk.groupEntries(key)) {
      if (
        !cur.exhausted &&
        compareSortKeys(e.sort, cur.after!, w.spec.order) > 0
      )
        break;
      n += e.weight;
    }
    return n;
  }

  private settle(cand: Map<string, readonly unknown[]>): boolean {
    const w = this.win!;
    const table = w.spec.anchorTable;
    let any = false;
    for (const key of cand.keys()) {
      const cur = this.cursors.get(key);
      if (!cur) continue;
      const keep = new Set<string>();
      const evict = new Set<string>(this.suspects.get(key) ?? []);
      let units = 0;
      let last: readonly unknown[] | undefined;
      let trimmed = false;
      for (const e of w.topk.groupEntries(key)) {
        const pk = this.anchorPkOf(e.sort);
        const beyond =
          !cur.exhausted &&
          compareSortKeys(e.sort, cur.after!, w.spec.order) > 0;
        if (beyond || units >= w.spec.pageSize) {
          evict.add(pk);
          if (!beyond) trimmed = true;
          continue;
        }
        units += e.weight;
        keep.add(pk);
        last = e.sort;
      }
      if (trimmed) {
        cur.after = last;
        cur.exhausted = false;
      }
      for (const pk of evict) {
        if (keep.has(pk)) continue;
        const prev = this.store.get(table, pk);
        if (!prev || this.partKeyOf(prev.row) !== key) continue;
        this.emit(table, prev.row, -1);
        this.store.delete(table, pk);
        any = true;
      }
    }
    return any;
  }

  private admits(src: LazySource, row: Row): boolean {
    const wanted = src.isDim
      ? this.dimWanted(src.table, row)
      : this.matches(src.table, row);
    if (!wanted) return false;
    const w = this.win;
    if (!w || src.table !== w.spec.anchorTable) return true;
    if (!this.matches(src.table, row)) return false;
    const cur = this.cursors.get(this.partKeyOf(row));
    if (!cur) return false;
    if (cur.exhausted) return true;
    const c = compareAnchorPrefix(row, cur.after!, w.spec.order);
    return c === undefined || c <= 0;
  }

  private anchorPkOf(sort: readonly unknown[]): string {
    const w = this.win!;
    const row: Row = {};
    const base = w.spec.order.length - w.spec.pkKeys;
    for (let i = base; i < w.spec.order.length; i++) {
      row[w.spec.order[i]!.column] = sort[i];
    }
    return this.store.pkOf(w.spec.anchorTable, row);
  }

  private partKeyOf(row: Row): string {
    return this.dimKey(this.anchor!, row);
  }

  private async fetchAnchorRows(src: LazySource): Promise<void> {
    const { snap, rows } = await this.rowSource.scopedRows(
      src.table,
      src.localPred,
      this.params
    );
    for (const row of rows) {
      if (!this.matches(src.table, row)) continue;
      const pk = this.store.pkOf(src.table, row);
      if (this.store.has(src.table, pk)) continue;
      this.store.set(src.table, pk, row, snap);
      this.emit(src.table, row, 1);
    }
  }

  private applyTableOp(op: ChangeOp, src: LazySource): void {
    const { table } = src;
    if (op.kind !== "insert") {
      this.retract(table, this.store.pkOf(table, op.oldRow!), op.xid);
      if (op.kind === "delete") return;
    }
    const row = op.newRow!;
    const pk = this.store.pkOf(table, row);
    if (this.store.alreadyReflected(table, pk, op.xid)) return;
    this.retract(table, pk, op.xid);
    if (this.admits(src, row)) {
      this.emit(table, row, 1);
      this.store.set(table, pk, row, null);
    }
  }

  private retract(table: string, pk: string, xid: number): void {
    const prev = this.store.get(table, pk);
    if (!prev || this.store.alreadyReflected(table, pk, xid)) return;
    this.emit(table, prev.row, -1);
    this.store.delete(table, pk);
  }

  private async closure(): Promise<void> {
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < this.sourcing.edges.length; i++) {
        const born = this.born[i]!;
        if (born.size === 0) continue;
        const refs = this.refs[i]!;
        const live = [...born].filter(vk => refs.has(vk));
        born.clear();
        if (live.length === 0) continue;
        if (this.win && i === this.anchor) {
          for (const vk of live) this.dirty.add(vk);
          continue;
        }
        const e = this.sourcing.edges[i]!;
        const { snap, rows } = await this.rowSource.fetchWhereIn(
          e.dimTable,
          e.dimCols,
          live.map(vk => refs.get(vk)!.value)
        );
        for (const row of rows) {
          const pk = this.store.pkOf(e.dimTable, row);
          if (this.store.has(e.dimTable, pk)) continue;
          this.store.set(e.dimTable, pk, row, snap);
          this.emit(e.dimTable, row, 1);
        }
        changed = true;
      }
    }
  }

  private matches(table: string, row: Row): boolean {
    const pred = this.admit.get(table);
    return pred ? pred(row) : true;
  }

  private dimWanted(table: string, row: Row): boolean {
    return (this.edgesByDim.get(table) ?? []).some(i =>
      this.refs[i]!.has(this.dimKey(i, row))
    );
  }

  private dimKey(i: number, row: Row): string {
    const e = this.sourcing.edges[i]!;
    return identityKey(
      e.dimCols.map(c => row[c]),
      e.classes
    );
  }

  private emit(table: string, row: Row, weight: 1 | -1): void {
    zsetAddRow(this.deltaFor(table), row, weight);
    if (this.win && table === this.win.spec.anchorTable)
      this.mark(this.partKeyOf(row), this.store.pkOf(table, row));
    for (const i of this.edgesByPuller.get(table) ?? []) {
      const { cols } = this.sourcing.edges[i]!.puller!;
      this.ref(
        i,
        cols.map(c => row[c]),
        weight
      );
    }
  }

  private ref(i: number, value: readonly unknown[], weight: number): void {
    if (value.some(isNull)) return;
    const vk = identityKey(value, this.sourcing.edges[i]!.classes);
    const refs = this.refs[i]!;
    const r = refs.get(vk);
    const count = (r?.count ?? 0) + weight;
    if (count === 0) {
      refs.delete(vk);
      this.dead[i]!.add(vk);
    } else if (r) r.count = count;
    else {
      refs.set(vk, { value, count });
      if (!this.dead[i]!.delete(vk)) this.born[i]!.add(vk);
    }
  }

  private finish(out: ZSet): ZSet {
    let dropped = false;
    for (;;) {
      const tables = new Set<string>();
      for (let i = 0; i < this.sourcing.edges.length; i++) {
        const dead = this.dead[i]!;
        if (dead.size === 0) continue;
        for (const vk of dead) {
          if (this.refs[i]!.has(vk)) continue;
          tables.add(this.sourcing.edges[i]!.dimTable);
          if (i === this.anchor) this.cursors.delete(vk);
        }
        dead.clear();
      }
      if (tables.size === 0) break;
      for (const table of tables) {
        const toDrop: { pk: string; row: Row }[] = [];
        for (const { row } of this.store.rows(table)) {
          if (!this.dimWanted(table, row))
            toDrop.push({ pk: this.store.pkOf(table, row), row });
        }
        for (const { pk, row } of toDrop) {
          this.emit(table, row, -1);
          this.store.delete(table, pk);
          dropped = true;
        }
      }
    }
    return dropped ? zsetMergeInto(out, this.step()) : out;
  }

  private step(): ZSet {
    const deltas = this.deltas;
    this.deltas = new Map();
    const out = this.plan.dataflow.step(deltas);
    const w = this.win;
    if (w) {
      for (const [key, removed] of w.topk.drainChanges()) {
        this.mark(key);
        for (const t of removed) this.mark(key, this.anchorPkOf(t));
      }
    }
    return out;
  }

  private deltaFor(table: string): ZSet {
    let z = this.deltas.get(table);
    if (!z) this.deltas.set(table, (z = emptyZSet()));
    return z;
  }
}
