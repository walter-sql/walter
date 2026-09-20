import { parseShapeSql } from "../src/parser/parse";
import {
  planShape,
  type LevelPlan,
  type ShapeTreePlan
} from "../src/planner/plan";
import { SchemaCatalog } from "../src/parser/catalog";
import type { ShapeQuery } from "../src/parser/ir";
import { StateStore, type RowOp } from "./state-store";
import { TreeMaterializer } from "../src/subscriptions/materializer";
import {
  emptyZSet,
  keyOf,
  stableStringify,
  zsetAddRow,
  type ZSet
} from "../src/ivm/zset";
import type { AppliedOps, TxnBatch } from "../src/cdc/types";
import type { LazyTree } from "../src/lazy/lazy-tree";
import type { RowSource } from "../src/lazy/rowsource";
import type { CollectionOp, RowValue } from "@walter-sql/view";

export type { RowOp };

export const commit = (
  xid: number,
  ops: RowOp[],
  truncated?: string[],
  position = BigInt(xid)
): TxnBatch => {
  const batch: TxnBatch = {
    xid,
    position,
    ops: ops.map(op => ({ ...op, xid }))
  };
  if (truncated) batch.truncated = truncated;
  return batch;
};

export async function seedTree(tree: LazyTree): Promise<CollectionOp[]> {
  await tree.load();
  return tree.flush();
}

export async function applyTxn(
  tree: LazyTree,
  batch: AppliedOps
): Promise<CollectionOp[]> {
  await tree.absorb(batch);
  return tree.flush();
}

export function withReads(
  inner: RowSource,
  reads: Partial<RowSource>
): RowSource {
  return Object.assign(Object.create(inner) as RowSource, reads);
}

export const TEST_TYPES: Record<string, Record<string, string>> = {
  users: { id: "int4", name: "text" },
  comments: {
    id: "int4",
    user_id: "int4",
    room_id: "int4",
    body: "text",
    score: "int4"
  },
  replies: { id: "int4", comment_id: "int4", body: "text" },
  events: { id: "int4", room_id: "int4", day: "int4", kind: "text" },
  totals: {
    id: "int4",
    room_id: "int4",
    day: "int4",
    n: "int4",
    rating: "float8"
  },
  item: {
    id: "int4",
    room: "text",
    score: "int4",
    name: "text",
    body: "text",
    payload: "jsonb"
  },
  rooms: { id: "int4", title: "text", rank: "int4", space: "text" }
};

export interface CatalogSpec {
  columnTypes?: Record<string, Record<string, string>>;
  keyColumnsByTable?: Record<string, string[]>;
  uniqueKeysByTable?: Record<string, string[][]>;
}

export function catalogOf(spec: CatalogSpec): SchemaCatalog {
  const catalog = new SchemaCatalog();
  for (const [t, types] of Object.entries(spec.columnTypes ?? {}))
    catalog.setColumnTypes(t, types);
  for (const [t, cols] of Object.entries(spec.keyColumnsByTable ?? {}))
    catalog.setKeyColumns(t, cols);
  for (const [t, keys] of Object.entries(spec.uniqueKeysByTable ?? {}))
    catalog.setUniqueKeys(t, keys);
  return catalog;
}

function withCatalog(spec: CatalogSpec): SchemaCatalog {
  return catalogOf({ ...spec, columnTypes: spec.columnTypes ?? TEST_TYPES });
}

export async function compileShape(
  sql: string,
  params: unknown[] = [],
  opts: CatalogSpec = {}
): Promise<{ query: ShapeQuery; shape: ShapeTreePlan }> {
  const catalog = withCatalog(opts);
  const query = await parseShapeSql(sql, catalog);
  const shape = planShape(query, params, catalog);
  return { query, shape };
}

export function allLevels(plan: ShapeTreePlan): LevelPlan[] {
  const out: LevelPlan[] = [];
  const walk = (level: LevelPlan): void => {
    out.push(level);
    for (const c of level.collections) walk(c.level);
  };
  walk(plan.root);
  return out;
}

function fullDelta(
  state: StateStore,
  tables: readonly string[]
): Map<string, ZSet> {
  const physical = new Map<string, ZSet>();
  for (const table of tables) {
    const z = emptyZSet();
    for (const row of state.rows(table)) zsetAddRow(z, row, 1);
    physical.set(table, z);
  }
  return physical;
}

function levelDelta(
  physical: Map<string, ZSet>,
  tables: readonly string[]
): Map<string, ZSet> {
  const out = new Map<string, ZSet>();
  for (const t of tables) {
    const z = physical.get(t);
    if (z) out.set(t, z);
  }
  return out;
}

export function recompute(
  query: ShapeQuery,
  params: unknown[],
  opts: CatalogSpec,
  state: StateStore
): Map<string, string> {
  const plan = planShape(query, params, withCatalog(opts));
  const mat = new TreeMaterializer(plan);
  const deltas = new Map<LevelPlan, ZSet>();
  for (const level of allLevels(plan)) {
    deltas.set(level, level.dataflow.step(fullDelta(state, level.tables)));
  }
  mat.apply(deltas);
  return viewToMap(mat);
}

export function viewToMap(mat: TreeMaterializer): Map<string, string> {
  const out = new Map<string, string>();
  const cols = [...mat.keyColumns];
  for (const value of mat.snapshot())
    out.set(keyOf(value, cols), stableStringify(value));
  return out;
}

export function mapsEqual(
  a: Map<string, string>,
  b: Map<string, string>
): string | undefined {
  if (a.size !== b.size) return `size ${a.size} != ${b.size}`;
  for (const [k, v] of a) {
    if (!b.has(k)) return `missing key ${k}`;
    if (b.get(k) !== v)
      return `value mismatch at ${k}:\n  inc=${v}\n  rec=${b.get(k)}`;
  }
  return undefined;
}

export class IncrementalHarness {
  readonly state: StateStore;
  readonly plan: ShapeTreePlan;
  private readonly mat: TreeMaterializer;
  private readonly levels: LevelPlan[];
  lastChanges: CollectionOp[] = [];
  private readonly query: ShapeQuery;
  private readonly params: unknown[];
  private readonly opts: CatalogSpec;

  constructor(
    query: ShapeQuery,
    params: unknown[],
    opts: CatalogSpec,
    plan: ShapeTreePlan,
    keyColumnsByTable: Record<string, string[]>
  ) {
    this.query = query;
    this.params = params;
    this.opts = opts;
    this.plan = plan;
    this.state = new StateStore();
    for (const [t, cols] of Object.entries(keyColumnsByTable))
      this.state.setKeyColumns(t, cols);
    this.levels = allLevels(plan);
    this.mat = new TreeMaterializer(plan);
  }

  static async create(
    sql: string,
    params: unknown[],
    opts: CatalogSpec,
    keyColumnsByTable: Record<string, string[]>
  ): Promise<IncrementalHarness> {
    const merged: CatalogSpec = { ...opts, keyColumnsByTable };
    const { query, shape } = await compileShape(sql, params, merged);
    return new IncrementalHarness(
      query,
      params,
      merged,
      shape,
      keyColumnsByTable
    );
  }

  static fromShape(
    query: ShapeQuery,
    params: unknown[],
    opts: CatalogSpec,
    keyColumnsByTable: Record<string, string[]>
  ): IncrementalHarness {
    const merged: CatalogSpec = { ...opts, keyColumnsByTable };
    const plan = planShape(query, params, withCatalog(merged));
    return new IncrementalHarness(
      query,
      params,
      merged,
      plan,
      keyColumnsByTable
    );
  }

  snapshotRows(): RowValue[] {
    return this.mat.snapshot();
  }

  get keyFields(): string[] {
    return [...this.mat.keyColumns];
  }

  applyOps(ops: RowOp[]): CollectionOp[] {
    const physical = this.state.ingest(ops);
    const deltas = new Map<LevelPlan, ZSet>();
    for (const level of this.levels)
      deltas.set(
        level,
        level.dataflow.step(levelDelta(physical, level.tables))
      );
    this.lastChanges = this.mat.apply(deltas);
    return this.lastChanges;
  }

  seed(initial: RowOp[]): CollectionOp[] {
    return this.applyOps(initial);
  }

  incremental(): Map<string, string> {
    return viewToMap(this.mat);
  }

  recomputed(): Map<string, string> {
    return recompute(this.query, this.params, this.opts, this.state);
  }
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0xffffffff;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)]!;
  }
}
