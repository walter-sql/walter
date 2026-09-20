import { DataflowNode } from "./node";
import {
  NULL_BUCKET,
  bucketize,
  emptyTupleZSet,
  tzAdd,
  tzMergeInto,
  type Tuple,
  type TupleKey,
  type TupleZSet
} from "./tuple";
import type { CompiledPredicate } from "../planner/compile";

interface LeftEntry {
  t: Tuple;
  weight: number;
  matches: number;
}

interface LeftBefore {
  t: Tuple;
  w: number;
  m: number;
}

export class JoinNode extends DataflowNode {
  override readonly inputs: DataflowNode[];

  private readonly leftState = new Map<string, Map<string, LeftEntry>>();
  private readonly rightState = new Map<string, TupleZSet>();
  private readonly nullPad: readonly null[];

  constructor(
    left: DataflowNode,
    right: DataflowNode,
    private readonly leftKey: TupleKey,
    private readonly rightKey: TupleKey,
    private readonly residual: CompiledPredicate | undefined,
    private readonly joinType: "inner" | "left",
    rightArity: number
  ) {
    super();
    this.inputs = [left, right];
    this.nullPad = new Array<null>(rightArity).fill(null);
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const out = emptyTupleZSet();

    const leftByKey = bucketize(inputDeltas[0]!, this.leftKey);
    const rightByKey = bucketize(inputDeltas[1]!, this.rightKey);

    const nullLeft = leftByKey.get(NULL_BUCKET);
    if (nullLeft && this.joinType === "left") {
      for (const { t, weight } of nullLeft.values())
        tzAdd(out, [...t, ...this.nullPad], weight);
    }
    leftByKey.delete(NULL_BUCKET);
    rightByKey.delete(NULL_BUCKET);

    const touched = new Set<string>([
      ...leftByKey.keys(),
      ...rightByKey.keys()
    ]);
    for (const key of touched) {
      this.stepKey(key, leftByKey.get(key), rightByKey.get(key), out);
    }
    return out;
  }

  private stepKey(
    key: string,
    dA: TupleZSet | undefined,
    dB: TupleZSet | undefined,
    out: TupleZSet
  ): void {
    let A = this.leftState.get(key);
    const B = this.rightState.get(key) ?? emptyTupleZSet();

    const before =
      this.joinType === "left" ? new Map<string, LeftBefore>() : undefined;
    const snap = (rk: string, t: Tuple, e: LeftEntry | undefined): void => {
      if (before && !before.has(rk)) {
        before.set(rk, { t, w: e?.weight ?? 0, m: e?.matches ?? 0 });
      }
    };

    if (dA) {
      if (!A) {
        A = new Map();
        this.leftState.set(key, A);
      }
      for (const [rk, { t: lt, weight: dwL }] of dA) {
        const e = A.get(rk);
        snap(rk, lt, e);
        let m = 0;
        for (const { t: rt, weight: wR } of B.values()) {
          if (wR === 0) continue;
          const merged = [...lt, ...rt];
          if (this.residual && !this.residual(merged)) continue;
          tzAdd(out, merged, dwL * wR);
          m += wR;
        }
        if (e) e.weight += dwL;
        else A.set(rk, { t: lt, weight: dwL, matches: m });
      }
    }

    if (dB) {
      if (A) {
        for (const [rk, e] of A) {
          snap(rk, e.t, e);
          for (const { t: rt, weight: dwR } of dB.values()) {
            if (dwR === 0) continue;
            const merged = [...e.t, ...rt];
            if (this.residual && !this.residual(merged)) continue;
            tzAdd(out, merged, e.weight * dwR);
            e.matches += dwR;
          }
        }
      }
      const newB = tzMergeInto(B, dB);
      if (newB.size === 0) this.rightState.delete(key);
      else this.rightState.set(key, newB);
    }

    if (before) {
      for (const [rk, b] of before) {
        const e = A?.get(rk);
        const oldC = b.m <= 0 ? b.w : 0;
        const newC = (e?.matches ?? 0) <= 0 ? (e?.weight ?? 0) : 0;
        if (newC !== oldC) tzAdd(out, [...b.t, ...this.nullPad], newC - oldC);
      }
    }

    if (A) {
      for (const [rk, e] of A) if (e.weight === 0) A.delete(rk);
      if (A.size === 0) this.leftState.delete(key);
    }
  }

  override get stateSize(): number {
    let n = 0;
    for (const m of this.leftState.values()) n += m.size;
    for (const z of this.rightState.values()) n += z.size;
    return n;
  }
}
