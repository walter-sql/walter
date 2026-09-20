import { DataflowNode } from "./node";
import { emptyTupleZSet, type Tuple, type TupleZSet } from "./tuple";
import { compareSortKeys, identityKey, type SortKeySpec } from "../parser/eval";
import type { SortClass } from "../parser/pgtypes";

export interface TopKEntry {
  key: string;
  t: Tuple;
  sort: readonly unknown[];
  weight: number;
}

interface Group {
  all: Map<string, TopKEntry>;
  ordered: TopKEntry[];
  member: Map<string, { t: Tuple; weight: number }>;
}

export class TopKNode extends DataflowNode {
  override readonly inputs: DataflowNode[];
  private readonly groups = new Map<string, Group>();
  private changes = new Map<string, Tuple[]>();

  constructor(
    input: DataflowNode,
    private readonly groupSlots: readonly number[],
    private readonly groupClasses: readonly (SortClass | undefined)[],
    private readonly orderBy: readonly SortKeySpec[],
    private readonly sortStart: number,
    private readonly limit: number | undefined,
    private readonly offset: number
  ) {
    super();
    this.inputs = [input];
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const delta = inputDeltas[0]!;
    const touched = new Set<string>();
    for (const [k, { t, weight }] of delta) {
      const gk = this.groupKeyOf(t);
      touched.add(gk);
      let ch = this.changes.get(gk);
      if (!ch) this.changes.set(gk, (ch = []));
      let g = this.groups.get(gk);
      if (!g) {
        g = { all: new Map(), ordered: [], member: new Map() };
        this.groups.set(gk, g);
      }
      const cur = g.all.get(k);
      if (cur) {
        cur.weight += weight;
        if (cur.weight === 0) {
          g.ordered.splice(this.lowerBound(g.ordered, cur), 1);
          g.all.delete(k);
          ch.push(cur.t);
        }
      } else if (weight !== 0) {
        const sort = t.slice(
          this.sortStart,
          this.sortStart + this.orderBy.length
        );
        const e: TopKEntry = { key: k, t, sort, weight };
        g.all.set(k, e);
        g.ordered.splice(this.lowerBound(g.ordered, e), 0, e);
      }
    }

    const out = emptyTupleZSet();
    const start = this.offset;
    const end =
      this.limit === undefined
        ? Number.POSITIVE_INFINITY
        : this.offset + this.limit;
    for (const gk of touched) {
      const g = this.groups.get(gk)!;
      const newMember = new Map<string, { t: Tuple; weight: number }>();
      let cursor = 0;
      for (const e of g.ordered) {
        const lo = cursor;
        const hi = cursor + e.weight;
        const inWindow = Math.max(0, Math.min(hi, end) - Math.max(lo, start));
        if (inWindow > 0) newMember.set(e.key, { t: e.t, weight: inWindow });
        cursor = hi;
        if (cursor >= end) break;
      }

      const keys = new Set<string>([...g.member.keys(), ...newMember.keys()]);
      for (const k of keys) {
        const oldW = g.member.get(k)?.weight ?? 0;
        const newEntry = newMember.get(k);
        const newW = newEntry?.weight ?? 0;
        if (newW !== oldW) {
          const t = newEntry?.t ?? g.member.get(k)?.t;
          if (t) out.set(k, { t, weight: newW - oldW });
        }
      }
      g.member = newMember;
      if (g.all.size === 0) this.groups.delete(gk);
    }
    return out;
  }

  private groupKeyOf(t: Tuple): string {
    return identityKey(
      this.groupSlots.map(s => t[s]),
      this.groupClasses
    );
  }

  groupEntries(gk: string): readonly TopKEntry[] {
    return this.groups.get(gk)?.ordered ?? [];
  }

  drainChanges(): Map<string, Tuple[]> {
    const m = this.changes;
    this.changes = new Map();
    return m;
  }

  override get stateSize(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.all.size;
    return n;
  }

  private lowerBound(ordered: TopKEntry[], e: TopKEntry): number {
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareEntries(ordered[mid]!, e) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private compareEntries(a: TopKEntry, b: TopKEntry): number {
    return (
      compareSortKeys(a.sort, b.sort, this.orderBy) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
  }
}
