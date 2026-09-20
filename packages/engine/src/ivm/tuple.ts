import { stableStringify } from "./zset";
import { identityOf, isNull } from "../parser/eval";
import type { SortClass } from "../parser/pgtypes";
import type { CompiledExpr } from "../planner/compile";

export type Tuple = readonly unknown[];

export interface TupleEntry {
  t: Tuple;
  weight: number;
}

export type TupleZSet = Map<string, TupleEntry>;

export function emptyTupleZSet(): TupleZSet {
  return new Map();
}

export function tupleKey(t: Tuple): string {
  return stableStringify(t as unknown[]);
}

export function tzAdd(z: TupleZSet, t: Tuple, weight: number): void {
  if (weight === 0) return;
  const k = tupleKey(t);
  tzAddWithKey(z, k, t, weight);
}

export function tzAddWithKey(
  z: TupleZSet,
  k: string,
  t: Tuple,
  weight: number
): void {
  if (weight === 0) return;
  const existing = z.get(k);
  if (existing === undefined) {
    z.set(k, { t, weight });
    return;
  }
  existing.weight += weight;
  if (existing.weight === 0) z.delete(k);
}

export function tzMergeInto(target: TupleZSet, delta: TupleZSet): TupleZSet {
  for (const [k, e] of delta) tzAddWithKey(target, k, e.t, e.weight);
  return target;
}

export const NULL_BUCKET = "\u0000NULLKEY";

export type TupleKey = (t: Tuple) => string;

export function matchKey(
  parts: readonly CompiledExpr[],
  classes: readonly SortClass[]
): TupleKey {
  return t => {
    const ids: unknown[] = [];
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i]!(t);
      if (isNull(v)) return NULL_BUCKET;
      ids.push(identityOf(v, classes[i]));
    }
    return stableStringify(ids);
  };
}

export function bucketize(
  delta: TupleZSet,
  keyFn: TupleKey
): Map<string, TupleZSet> {
  const out = new Map<string, TupleZSet>();
  for (const [rk, e] of delta) {
    const k = keyFn(e.t);
    let bucket = out.get(k);
    if (!bucket) {
      bucket = emptyTupleZSet();
      out.set(k, bucket);
    }
    bucket.set(rk, e);
  }
  return out;
}
