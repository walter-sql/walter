import { compareOrderKey, type SortKeySpec } from "../parser/eval";
import type { Expr, FromItem } from "../parser/ir";
import type { ChangeOp } from "../cdc/types";
import { stableStringify, type Row } from "../ivm/zset";

export interface WindowSortKey extends SortKeySpec {
  alias: string;
  column: string;
  anchor: boolean;
}

export function wcol(i: number): string {
  return `__w${i}`;
}

export interface WindowFetchSpec {
  from: FromItem;
  where: Expr | undefined;
}

export interface JoinPair {
  partner: string;
  alias: string;
  column: string;
}

export interface PartnerTrigger {
  table: string;
  inner: boolean;
  sortWhere: readonly string[];
  pairs: readonly JoinPair[];
}

export interface RevealGroup {
  columns: readonly { alias: string; column: string }[];
  tuples: readonly (readonly unknown[])[];
}

export type Reveal = readonly RevealGroup[];

export function revealTargets(
  trig: PartnerTrigger,
  op: ChangeOp
): readonly (readonly unknown[])[] | undefined {
  const feedsSort = trig.sortWhere.length > 0;
  const tupleOf = (row: Row): readonly unknown[] =>
    trig.pairs.map(p => row[p.partner]);

  if (op.kind === "insert") {
    if (!trig.inner && !feedsSort) return undefined;
    return [tupleOf(op.newRow!)];
  }
  if (op.kind === "delete") {
    if (trig.inner || !feedsSort) return undefined;
    return [tupleOf(op.oldRow!)];
  }

  const newR = op.newRow!;
  const oldR = op.oldRow!;
  const changed = (c: string): boolean =>
    stableStringify(oldR[c]) !== stableStringify(newR[c]);
  const sortChanged = trig.sortWhere.some(changed);
  const pairChanged = trig.pairs.some(p => changed(p.partner));
  if (!sortChanged && !(pairChanged && (trig.inner || feedsSort))) {
    return undefined;
  }
  return pairChanged ? [tupleOf(newR), tupleOf(oldR)] : [tupleOf(newR)];
}

export interface WindowRead {
  anchorTable: string;
  anchorAlias: string;
  order: readonly WindowSortKey[];
  pageSize: number;
  fetch: WindowFetchSpec;
}

export interface WindowSpec extends WindowRead {
  pkKeys: number;
  windowSize: number;
  partnerTriggers: PartnerTrigger[];
}

export function pageSizeFor(windowSize: number): number {
  return windowSize + Math.max(16, windowSize >> 1);
}

export function windowTuple(
  row: Row,
  order: readonly WindowSortKey[]
): unknown[] {
  return order.map((k, i) => (k.anchor ? row[k.column] : row[wcol(i)]));
}

export function compareAnchorPrefix(
  row: Row,
  after: readonly unknown[],
  order: readonly WindowSortKey[]
): number | undefined {
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!;
    if (!k.anchor) return undefined;
    const c = compareOrderKey(
      row[k.column],
      after[i],
      k.desc,
      k.nullsFirst,
      k.cls
    );
    if (c !== 0) return c;
  }
  return 0;
}
