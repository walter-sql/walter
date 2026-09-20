import { DataflowNode } from "./node";
import {
  NULL_BUCKET,
  bucketize,
  emptyTupleZSet,
  tzAddWithKey,
  tzMergeInto,
  type TupleKey,
  type TupleZSet
} from "./tuple";

export class ExistsNode extends DataflowNode {
  override readonly inputs: DataflowNode[];
  private readonly parentState = new Map<string, TupleZSet>();
  private readonly childWeight = new Map<string, number>();

  constructor(
    parent: DataflowNode,
    child: DataflowNode,
    private readonly outerKey: TupleKey,
    private readonly innerKey: TupleKey,
    private readonly negated: boolean
  ) {
    super();
    this.inputs = [parent, child];
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const out = emptyTupleZSet();

    const parentByKey = bucketize(inputDeltas[0]!, this.outerKey);
    const childByKey = bucketize(inputDeltas[1]!, this.innerKey);

    const touched = new Set<string>([
      ...parentByKey.keys(),
      ...childByKey.keys()
    ]);

    for (const key of touched) {
      const oldChildW =
        key === NULL_BUCKET ? 0 : (this.childWeight.get(key) ?? 0);
      const dCw = key === NULL_BUCKET ? 0 : sumWeights(childByKey.get(key));
      const newChildW = oldChildW + dCw;
      const oldPass = this.passes(oldChildW);
      const newPass = this.passes(newChildW);

      const parents = this.parentState.get(key);
      const dP = parentByKey.get(key);

      if (oldPass === newPass) {
        if (newPass && dP)
          for (const [k, e] of dP) tzAddWithKey(out, k, e.t, e.weight);
      } else if (oldPass) {
        if (parents)
          for (const [k, e] of parents) tzAddWithKey(out, k, e.t, -e.weight);
      }

      let next = parents;
      if (dP) {
        if (!next) next = emptyTupleZSet();
        tzMergeInto(next, dP);
      }

      if (!oldPass && newPass && next)
        for (const [k, e] of next) tzAddWithKey(out, k, e.t, e.weight);

      if (!next || next.size === 0) this.parentState.delete(key);
      else this.parentState.set(key, next);
      if (key !== NULL_BUCKET) {
        if (newChildW === 0) this.childWeight.delete(key);
        else this.childWeight.set(key, newChildW);
      }
    }

    return out;
  }

  override get stateSize(): number {
    let n = this.childWeight.size;
    for (const z of this.parentState.values()) n += z.size;
    return n;
  }

  private passes(childW: number): boolean {
    return this.negated ? childW <= 0 : childW > 0;
  }
}

function sumWeights(z: TupleZSet | undefined): number {
  if (!z) return 0;
  let s = 0;
  for (const e of z.values()) s += e.weight;
  return s;
}
