import { keyOf, stableStringify, type Row, type ZSet } from "../ivm/zset";
import { compareSortKeys, identityKey } from "../parser/eval";
import type { SortClass } from "../parser/pgtypes";
import type {
  CollectionOp,
  ElementOp,
  OrderMove,
  RowValue
} from "@walter-sql/view";
import type { LevelPlan, ShapeTreePlan } from "../planner/plan";

export class ResultKeyCollisionError extends Error {
  override readonly name = "ResultKeyCollisionError";
  constructor(resultKey: string, count: number) {
    super(
      `result-key collision: ${count} distinct rows share result key ` +
        `${JSON.stringify(resultKey)} - keyColumns do not uniquely key the level`
    );
  }
}

interface ElementState {
  contents: Map<string, { row: Row; weight: number }>;
  current: Row | undefined;
  count: number;
}

interface GroupState {
  elements: Map<string, ElementState>;
  orderedKeys: string[];
}

interface GroupDelta {
  added: { ek: string; row: Row }[];
  fresh: Set<string>;
  removed: { ek: string; row: Row }[];
  updated: { ek: string; oldRow: Row; newRow: Row }[];
  removeAt: number[];
  moves: OrderMove[];
  oldOrdered: string[];
}

interface Edge {
  field: string;
  parentKey: string[];
  classes: readonly (SortClass | undefined)[];
  single: boolean;
  parentLevel: LevelMaterializer;
  childLevel: LevelMaterializer;
  groupOwner: Map<string, Set<string>>;
}

class LevelMaterializer {
  readonly groups = new Map<string, GroupState>();
  readonly groupOf = new Map<string, string>();
  readonly childEdges: Edge[] = [];
  parentEdge: Edge | undefined;

  constructor(readonly plan: LevelPlan) {}

  groupKeyOf(row: Row): string {
    const corr = this.plan.correlationSource;
    if (!corr) return "";
    return identityKey(
      corr.aliases.map(a => row[a]),
      corr.classes
    );
  }

  elementKeyOf(row: Row): string {
    return keyOf(row, this.plan.keyColumns);
  }

  assemble(row: Row): RowValue {
    const out: RowValue = {};
    for (const col of this.plan.wireColumns) out[col] = row[col];
    for (const edge of this.childEdges)
      out[edge.field] = childField(edge, parentKeyOf(edge, row));
    return out;
  }

  private orderGroup(group: GroupState): string[] {
    const order = this.plan.order;
    const sorted = [...group.elements]
      .map(([ek, el]) => ({
        ek,
        sort: order.map(o => el.current![o.field]),
        count: el.count
      }))
      .sort(
        (a, b) =>
          compareSortKeys(a.sort, b.sort, order) ||
          (a.ek < b.ek ? -1 : a.ek > b.ek ? 1 : 0)
      );
    const out: string[] = [];
    for (const { ek, count } of sorted) {
      for (let i = 0; i < count; i++) out.push(ek);
    }
    return out;
  }

  ingest(delta: ZSet): Map<string, GroupDelta> {
    const buckets = new Map<
      string,
      Map<string, { row: Row; weight: number }[]>
    >();
    for (const { row, weight } of delta.values()) {
      const gk = this.groupKeyOf(row);
      const ek = this.elementKeyOf(row);
      let g = buckets.get(gk);
      if (!g) buckets.set(gk, (g = new Map()));
      let e = g.get(ek);
      if (!e) g.set(ek, (e = []));
      e.push({ row, weight });
    }

    const out = new Map<string, GroupDelta>();
    for (const [gk, elems] of buckets) {
      let group = this.groups.get(gk);
      if (!group)
        this.groups.set(gk, (group = { elements: new Map(), orderedKeys: [] }));
      const oldOrdered = group.orderedKeys;
      const gd: GroupDelta = {
        added: [],
        fresh: new Set(),
        removed: [],
        updated: [],
        removeAt: [],
        moves: [],
        oldOrdered
      };
      const surviving = new Map<string, number>();
      for (const [ek, entries] of elems) {
        let es = group.elements.get(ek);
        const old = es?.current;
        const oldCount = es?.count ?? 0;
        if (!es) es = { contents: new Map(), current: undefined, count: 0 };
        for (const { row, weight } of entries) {
          const ck = stableStringify(row);
          const cur = es.contents.get(ck);
          const nw = (cur?.weight ?? 0) + weight;
          if (nw === 0) es.contents.delete(ck);
          else es.contents.set(ck, { row, weight: nw });
        }
        const next = pickCurrent(es.contents, ek);
        es.current = next?.row;
        es.count = next?.weight ?? 0;
        if (next === undefined) {
          group.elements.delete(ek);
          if (old !== undefined) gd.removed.push({ ek, row: old });
        } else {
          group.elements.set(ek, es);
          if (old === undefined) {
            gd.fresh.add(ek);
            this.register(ek, gk, next.row);
          } else if (wireDiffers(old, next.row, this.plan.wireColumns)) {
            gd.updated.push({ ek, oldRow: old, newRow: next.row });
          }
        }
        const kept = Math.min(oldCount, es.count);
        surviving.set(ek, kept);
        for (let i = kept; i < es.count; i++)
          gd.added.push({ ek, row: es.current! });
      }

      const seen = new Map<string, number>();
      const naive: string[] = [];
      oldOrdered.forEach((ek, i) => {
        const keep = surviving.get(ek);
        if (keep === undefined) {
          naive.push(ek);
          return;
        }
        const n = (seen.get(ek) ?? 0) + 1;
        seen.set(ek, n);
        if (n <= keep) naive.push(ek);
        else gd.removeAt.push(i);
      });
      for (const a of gd.added) naive.push(a.ek);
      group.orderedKeys = this.orderGroup(group);
      gd.moves = orderMoves(naive, group.orderedKeys);
      out.set(gk, gd);
    }
    return out;
  }

  private register(ek: string, gk: string, row: Row): void {
    this.groupOf.set(ek, gk);
    for (const edge of this.childEdges) {
      const k = parentKeyOf(edge, row);
      let owners = edge.groupOwner.get(k);
      if (!owners) edge.groupOwner.set(k, (owners = new Set()));
      owners.add(ek);
    }
  }

  cleanup(removed: { ek: string; row: Row }[]): void {
    for (const { ek, row } of removed) {
      const cur = this.groupOf.get(ek);
      if (cur !== undefined && this.groups.get(cur)?.elements.has(ek)) continue;
      this.groupOf.delete(ek);
      for (const edge of this.childEdges) {
        const k = parentKeyOf(edge, row);
        const owners = edge.groupOwner.get(k);
        if (owners) {
          owners.delete(ek);
          if (owners.size === 0) edge.groupOwner.delete(k);
        }
      }
    }
    for (const [gk, group] of this.groups)
      if (group.elements.size === 0) this.groups.delete(gk);
  }
}

export class TreeMaterializer {
  private readonly root: LevelMaterializer;
  private readonly levels: LevelMaterializer[] = [];

  constructor(plan: ShapeTreePlan) {
    this.root = this.build(plan.root, undefined);
  }

  private build(
    plan: LevelPlan,
    parentEdge: Edge | undefined
  ): LevelMaterializer {
    const level = new LevelMaterializer(plan);
    this.levels.push(level);
    level.parentEdge = parentEdge;
    for (const c of plan.collections) {
      const edge: Edge = {
        field: c.field,
        parentKey: c.parentKey,
        classes: c.level.correlationSource!.classes,
        single: c.single,
        parentLevel: level,
        childLevel: undefined as unknown as LevelMaterializer,
        groupOwner: new Map()
      };
      edge.childLevel = this.build(c.level, edge);
      level.childEdges.push(edge);
    }
    return level;
  }

  get keyColumns(): readonly string[] {
    return this.root.plan.keyColumns;
  }

  apply(deltas: ReadonlyMap<LevelPlan, ZSet>): CollectionOp[] {
    const perLevel = new Map<LevelMaterializer, Map<string, GroupDelta>>();
    for (const level of this.levels) {
      const delta = deltas.get(level.plan);
      if (delta && delta.size > 0) perLevel.set(level, level.ingest(delta));
    }

    const oldOrder = (lvl: LevelMaterializer, gk: string): string[] =>
      perLevel.get(lvl)?.get(gk)?.oldOrdered ??
      lvl.groups.get(gk)?.orderedKeys ??
      [];

    const collOps = new Map<LevelMaterializer, Map<string, CollectionOp[]>>();
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i]!;
      const groups = perLevel.get(level);
      const out = new Map<string, CollectionOp[]>();
      const opsFor = (gk: string): CollectionOp[] => {
        let a = out.get(gk);
        if (!a) out.set(gk, (a = []));
        return a;
      };
      const elemOps = new Map<string, ElementOp[]>();
      const elemFor = (ek: string): ElementOp[] => {
        let a = elemOps.get(ek);
        if (!a) elemOps.set(ek, (a = []));
        return a;
      };

      const covered = new Set<string>();
      if (groups)
        for (const gd of groups.values()) {
          for (const ek of gd.fresh) covered.add(ek);
          for (const r of gd.removed) covered.add(r.ek);
          for (const u of gd.updated) {
            const eops = elemFor(u.ek);
            for (const col of level.plan.wireColumns)
              if (
                stableStringify(u.oldRow[col]) !==
                stableStringify(u.newRow[col])
              )
                eops.push({ op: "set", field: col, value: u.newRow[col] });
          }
        }

      const reshipped = new Map<Edge, Set<string>>();
      if (groups)
        for (const gd of groups.values())
          for (const u of gd.updated)
            for (const edge of level.childEdges) {
              const oldK = parentKeyOf(edge, u.oldRow);
              const newK = parentKeyOf(edge, u.newRow);
              if (oldK === newK) continue;
              const old = edge.groupOwner.get(oldK);
              if (old) {
                old.delete(u.ek);
                if (old.size === 0) edge.groupOwner.delete(oldK);
              }
              let next = edge.groupOwner.get(newK);
              if (!next) edge.groupOwner.set(newK, (next = new Set()));
              next.add(u.ek);
              elemFor(u.ek).push({
                op: "set",
                field: edge.field,
                value: childField(edge, newK)
              });
              let r = reshipped.get(edge);
              if (!r) reshipped.set(edge, (r = new Set()));
              r.add(u.ek);
            }

      for (const edge of level.childEdges) {
        const childCols = collOps.get(edge.childLevel);
        if (!childCols) continue;
        const skip = reshipped.get(edge);
        for (const [childGk, ops] of childCols) {
          if (ops.length === 0) continue;
          const owners = edge.groupOwner.get(childGk);
          if (!owners) continue;
          for (const ek of owners) {
            if (covered.has(ek) || skip?.has(ek)) continue;
            elemFor(ek).push(
              edge.single
                ? toOneOp(edge.field, ops)
                : { op: "nest", field: edge.field, ops }
            );
          }
        }
      }

      if (groups)
        for (const [gk, gd] of groups) {
          const ops = opsFor(gk);
          for (const index of gd.removeAt) ops.push({ op: "remove", index });
          for (const a of gd.added)
            ops.push({ op: "add", value: level.assemble(a.row) });
          if (gd.moves.length > 0) ops.push({ op: "reorder", moves: gd.moves });
        }
      for (const [ek, eops] of elemOps) {
        if (eops.length === 0) continue;
        const gk = level.groupOf.get(ek)!;
        const order = oldOrder(level, gk);
        for (let index = 0; index < order.length; index++)
          if (order[index] === ek)
            opsFor(gk).push({ op: "update", index, ops: eops });
      }

      collOps.set(level, out);
    }

    for (const [level, groups] of perLevel) {
      const removed: { ek: string; row: Row }[] = [];
      for (const gd of groups.values()) removed.push(...gd.removed);
      level.cleanup(removed);
    }

    return collOps.get(this.root)?.get("") ?? [];
  }

  get stateSize(): number {
    let n = 0;
    for (const lvl of this.levels) {
      n += lvl.groupOf.size;
      for (const g of lvl.groups.values()) n += g.elements.size;
    }
    return n;
  }

  snapshot(): RowValue[] {
    const group = this.root.groups.get("");
    if (!group) return [];
    return group.orderedKeys.map(ek =>
      this.root.assemble(group.elements.get(ek)!.current!)
    );
  }
}

function childField(edge: Edge, key: string): RowValue | RowValue[] | null {
  const group = edge.childLevel.groups.get(key);
  if (edge.single) {
    const ck = group?.orderedKeys[0];
    return ck === undefined
      ? null
      : edge.childLevel.assemble(group!.elements.get(ck)!.current!);
  }
  return group
    ? group.orderedKeys.map(ck =>
        edge.childLevel.assemble(group.elements.get(ck)!.current!)
      )
    : [];
}

function toOneOp(field: string, ops: CollectionOp[]): ElementOp {
  const add = ops.find(o => o.op === "add");
  if (add && add.op === "add") return { op: "set", field, value: add.value };
  if (ops.some(o => o.op === "remove"))
    return { op: "set", field, value: null };
  const upd = ops.find(o => o.op === "update");
  if (upd && upd.op === "update") return { op: "patch", field, ops: upd.ops };
  return { op: "set", field, value: null };
}

function parentKeyOf(edge: Edge, row: Row): string {
  return identityKey(
    edge.parentKey.map(c => row[c]),
    edge.classes
  );
}

function pickCurrent(
  contents: Map<string, { row: Row; weight: number }>,
  ek: string
): { row: Row; weight: number } | undefined {
  let best: { row: Row; weight: number } | undefined;
  let positives = 0;
  for (const entry of contents.values()) {
    if (entry.weight > 0) {
      positives++;
      best ??= entry;
    }
  }
  if (positives > 1) throw new ResultKeyCollisionError(ek, positives);
  return best;
}

function wireDiffers(a: Row, b: Row, wireColumns: readonly string[]): boolean {
  for (const c of wireColumns)
    if (stableStringify(a[c]) !== stableStringify(b[c])) return true;
  return false;
}

function orderMoves(naive: string[], target: string[]): OrderMove[] {
  if (naive.length === 0) return [];
  const pos = new Map<string, number[]>();
  target.forEach((ek, i) => {
    let list = pos.get(ek);
    if (!list) pos.set(ek, (list = []));
    list.push(i);
  });
  const taken = new Map<string, number>();
  const seq = naive.map(ek => {
    const n = taken.get(ek) ?? 0;
    taken.set(ek, n + 1);
    return pos.get(ek)![n]!;
  });

  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const inLis = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0;) {
    inLis.add(i);
    i = prev[i]!;
  }

  const moves: OrderMove[] = [];
  for (let i = 0; i < naive.length; i++) {
    if (!inLis.has(i)) moves.push({ from: i, to: seq[i]! });
  }
  moves.sort((a, b) => a.to - b.to);
  return moves;
}
