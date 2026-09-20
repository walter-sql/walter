import { stableStringify } from "./zset";
import { DataflowNode } from "./node";
import { emptyTupleZSet, tzAdd, type Tuple, type TupleZSet } from "./tuple";
import {
  compareClassValues,
  compareSortKeys,
  identityKey,
  identityOf,
  isNull,
  type SortKeySpec
} from "../parser/eval";
import type { SortClass } from "../parser/pgtypes";
import { DecSum, decExact, decFrom, type Dec } from "../parser/decimal";
import { SqlEvalError, type PgClass } from "../parser/ir";
import type { CompiledExpr, CompiledPredicate } from "../planner/compile";

export class DistinctNode extends DataflowNode {
  override readonly inputs: DataflowNode[];
  private readonly counts = new Map<string, { t: Tuple; count: number }>();

  constructor(
    input: DataflowNode,
    private readonly classes: readonly (SortClass | undefined)[]
  ) {
    super();
    this.inputs = [input];
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const delta = inputDeltas[0]!;
    const out = emptyTupleZSet();
    for (const { t, weight } of delta.values()) {
      const k = identityKey(t, this.classes);
      const prev = this.counts.get(k);
      const rep = prev?.t ?? t;
      const oldCount = prev?.count ?? 0;
      const newCount = oldCount + weight;
      const oldW = oldCount > 0 ? 1 : 0;
      const newW = newCount > 0 ? 1 : 0;
      if (newCount === 0) this.counts.delete(k);
      else this.counts.set(k, { t: rep, count: newCount });
      if (newW !== oldW) tzAdd(out, rep, newW - oldW);
    }
    return out;
  }

  override get stateSize(): number {
    return this.counts.size;
  }
}

export type CompiledAggregateSpec = {
  filter?: CompiledPredicate;
  cls?: SortClass;
} & (
  | { type: "count"; arg?: CompiledExpr; distinct: boolean }
  | {
      type: "sum";
      arg: CompiledExpr;
      distinct: boolean;
      out: PgClass;
    }
  | { type: "avg"; arg: CompiledExpr; distinct: boolean }
  | {
      type: "min" | "max";
      arg: CompiledExpr;
      distinct: boolean;
      cls: SortClass;
    }
  | {
      type: "jsonAgg";
      arg: CompiledExpr;
      orderBy?: ({ expr: CompiledExpr } & SortKeySpec)[];
    }
);

export class AggregateNode extends DataflowNode {
  override readonly inputs: DataflowNode[];
  private readonly groups = new Map<string, GroupAccumulator>();
  private singletonSeeded = false;

  constructor(
    input: DataflowNode,
    private readonly groupBy: readonly CompiledExpr[],
    private readonly groupClasses: readonly (SortClass | undefined)[],
    private readonly aggregates: readonly CompiledAggregateSpec[]
  ) {
    super();
    this.inputs = [input];
  }

  private get isScalar(): boolean {
    return this.groupBy.length === 0;
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const delta = inputDeltas[0]!;
    const out = emptyTupleZSet();

    if (this.isScalar && !this.singletonSeeded) {
      this.singletonSeeded = true;
      const acc = new GroupAccumulator([], this.aggregates);
      this.groups.set("", acc);
      tzAdd(out, acc.buildTuple(), 1);
    }

    const byGroup = new Map<
      string,
      { acc: GroupAccumulator; rows: { t: Tuple; weight: number }[] }
    >();
    for (const { t, weight } of delta.values()) {
      const groupValues = this.groupBy.map(f => f(t));
      const key = identityKey(groupValues, this.groupClasses);
      let bucket = byGroup.get(key);
      if (!bucket) {
        let acc = this.groups.get(key);
        if (!acc) {
          acc = new GroupAccumulator(groupValues, this.aggregates);
          this.groups.set(key, acc);
        }
        bucket = { acc, rows: [] };
        byGroup.set(key, bucket);
      }
      bucket.rows.push({ t, weight });
    }

    for (const [key, { acc, rows }] of byGroup) {
      const existedBefore = this.isScalar ? true : acc.weight > 0;
      const oldTuple = existedBefore ? acc.buildTuple() : undefined;

      for (const { t, weight } of rows) acc.apply(t, weight);

      const existsAfter = this.isScalar ? true : acc.weight > 0;
      const newTuple = existsAfter ? acc.buildTuple() : undefined;

      if (oldTuple) tzAdd(out, oldTuple, -1);
      if (newTuple) tzAdd(out, newTuple, 1);

      if (!existsAfter && !this.isScalar) this.groups.delete(key);
    }

    return out;
  }

  override get stateSize(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.weight > 0) n++;
    return n;
  }
}

class GroupAccumulator {
  weight = 0;
  private readonly states: AggState<Tuple>[];

  constructor(
    private readonly groupValues: unknown[],
    specs: readonly CompiledAggregateSpec[]
  ) {
    this.states = specs.map(makeAggState);
  }

  apply(t: Tuple, weight: number): void {
    this.weight += weight;
    for (const st of this.states) st.add(t, weight);
  }

  buildTuple(): Tuple {
    return [...this.groupValues, ...this.states.map(st => st.value())];
  }
}

interface AggState<In> {
  add(x: In, weight: number): void;
  value(): unknown;
}

function makeAggState(spec: CompiledAggregateSpec): AggState<Tuple> {
  const state = rowAggState(spec);
  return spec.filter ? new FilteredAgg(state, spec.filter) : state;
}

function rowAggState(spec: CompiledAggregateSpec): AggState<Tuple> {
  if (spec.type === "jsonAgg") return new JsonAggState(spec.arg, spec.orderBy);
  if (spec.arg === undefined) return new CountAgg();
  const values = spec.distinct
    ? new DistinctAgg(spec.cls, () => valueAggState(spec))
    : valueAggState(spec);
  return new ArgAgg(spec.arg, values);
}

function valueAggState(
  spec: Exclude<CompiledAggregateSpec, { type: "jsonAgg" }>
): AggState<unknown> {
  switch (spec.type) {
    case "count":
      return new CountAgg();
    case "sum":
      return new SumAgg("sum", spec.out);
    case "avg":
      return new SumAgg("avg");
    case "min":
    case "max":
      return new ExtremeAgg(spec.type, spec.cls);
  }
}

class WeightedBag<T> {
  private readonly m = new Map<string, { item: T; weight: number }>();
  add(key: string, item: T, weight: number): void {
    const cur = this.m.get(key);
    const nw = (cur?.weight ?? 0) + weight;
    if (nw === 0) this.m.delete(key);
    else this.m.set(key, { item, weight: nw });
  }
  *present(): IterableIterator<{ item: T; weight: number }> {
    for (const e of this.m.values()) if (e.weight > 0) yield e;
  }
}

class FilteredAgg implements AggState<Tuple> {
  constructor(
    private readonly inner: AggState<Tuple>,
    private readonly filter: CompiledPredicate
  ) {}
  add(t: Tuple, weight: number): void {
    if (this.filter(t)) this.inner.add(t, weight);
  }
  value(): unknown {
    return this.inner.value();
  }
}

class ArgAgg implements AggState<Tuple> {
  constructor(
    private readonly arg: CompiledExpr,
    private readonly inner: AggState<unknown>
  ) {}
  add(t: Tuple, weight: number): void {
    const v = this.arg(t);
    if (!isNull(v)) this.inner.add(v, weight);
  }
  value(): unknown {
    return this.inner.value();
  }
}

class DistinctAgg implements AggState<unknown> {
  private readonly values = new WeightedBag<unknown>();
  constructor(
    private readonly cls: SortClass | undefined,
    private readonly fresh: () => AggState<unknown>
  ) {}
  add(v: unknown, weight: number): void {
    this.values.add(stableStringify(identityOf(v, this.cls)), v, weight);
  }
  value(): unknown {
    const base = this.fresh();
    for (const { item } of this.values.present()) base.add(item, 1);
    return base.value();
  }
}

class CountAgg implements AggState<unknown> {
  private total = 0;
  add(_x: unknown, weight: number): void {
    this.total += weight;
  }
  value(): unknown {
    return String(this.total);
  }
}

class NonFiniteWeights {
  nan = 0;
  posInf = 0;
  negInf = 0;
  add(v: unknown, weight: number): boolean {
    if (v === "NaN") this.nan += weight;
    else if (v === "Infinity") this.posInf += weight;
    else if (v === "-Infinity") this.negInf += weight;
    else return false;
    return true;
  }
  form(): "NaN" | "Infinity" | "-Infinity" | undefined {
    if (this.nan > 0 || (this.posInf > 0 && this.negInf > 0)) return "NaN";
    if (this.posInf > 0) return "Infinity";
    if (this.negInf > 0) return "-Infinity";
    return undefined;
  }
}

function decOf(v: unknown): Dec | null {
  return typeof v === "number" ? decExact(v) : decFrom(v);
}

function renderSum(
  text: string,
  count: number,
  mode: "sum" | "avg",
  out: PgClass
): unknown {
  if (out === "int8") {
    if (BigInt(text) > 2n ** 63n - 1n || BigInt(text) < -(2n ** 63n))
      throw new SqlEvalError("bigint out of range");
    return text;
  }
  if (out === "numeric") return text;
  const v = Number(text);
  if (!Number.isFinite(v))
    throw new SqlEvalError("value out of range: overflow");
  return mode === "sum" ? v : v / count;
}

class SumAgg implements AggState<unknown> {
  private readonly dec = new DecSum();
  private readonly nonFinite = new NonFiniteWeights();
  private count = 0;
  constructor(
    private readonly mode: "sum" | "avg",
    private readonly out: PgClass = "float"
  ) {}
  add(v: unknown, weight: number): void {
    this.count += weight;
    if (this.nonFinite.add(v, weight)) return;
    const d = decOf(v);
    if (d) this.dec.add(d, weight);
  }
  value(): unknown {
    if (this.count <= 0) return null;
    return (
      this.nonFinite.form() ??
      renderSum(this.dec.value()!, this.count, this.mode, this.out)
    );
  }
}

class ExtremeAgg implements AggState<unknown> {
  private readonly values = new WeightedBag<unknown>();
  constructor(
    private readonly kind: "min" | "max",
    private readonly cls: SortClass
  ) {}
  add(v: unknown, weight: number): void {
    this.values.add(stableStringify(v), v, weight);
  }
  value(): unknown {
    let best: unknown = null;
    let seen = false;
    for (const { item } of this.values.present()) {
      if (!seen) {
        best = item;
        seen = true;
        continue;
      }
      const c = compareClassValues(item, best, this.cls);
      if (this.kind === "min" ? c < 0 : c > 0) best = item;
    }
    return seen ? best : null;
  }
}

class JsonAggState implements AggState<Tuple> {
  private readonly elems = new WeightedBag<{
    value: unknown;
    sortVals: unknown[];
  }>();
  constructor(
    private readonly arg: CompiledExpr,
    private readonly orderBy?: ({ expr: CompiledExpr } & SortKeySpec)[]
  ) {}
  add(t: Tuple, weight: number): void {
    const value = this.arg(t);
    const sortVals = (this.orderBy ?? []).map(o => o.expr(t));
    this.elems.add(stableStringify(value), { value, sortVals }, weight);
  }
  value(): unknown {
    const items = [...this.elems.present()];
    const keys = this.orderBy;
    if (keys && keys.length > 0) {
      items.sort((a, b) =>
        compareSortKeys(a.item.sortVals, b.item.sortVals, keys)
      );
    }
    const out: unknown[] = [];
    for (const { item, weight } of items) {
      for (let i = 0; i < weight; i++) out.push(item.value);
    }
    return out;
  }
}
