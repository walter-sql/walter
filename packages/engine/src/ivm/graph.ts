import { emptyZSet, zsetAddRow, type ZSet } from "./zset";
import { DataflowNode, SourceNode, tupleToRow } from "./node";
import type { TupleZSet } from "./tuple";

export class Dataflow {
  constructor(
    readonly root: DataflowNode,
    readonly sources: readonly SourceNode[],
    readonly outputColumns: readonly string[]
  ) {}

  step(physicalDeltas: ReadonlyMap<string, ZSet>): ZSet {
    for (const source of this.sources) {
      const phys = physicalDeltas.get(source.table);
      source.pending = phys ? source.load(phys) : new Map();
    }
    const memo = new Map<DataflowNode, TupleZSet>();
    const rootDelta = evaluate(this.root, memo);
    const out = emptyZSet();
    for (const { t, weight } of rootDelta.values()) {
      zsetAddRow(out, tupleToRow(t, this.outputColumns), weight);
    }
    return out;
  }
}

function evaluate(
  node: DataflowNode,
  memo: Map<DataflowNode, TupleZSet>
): TupleZSet {
  const cached = memo.get(node);
  if (cached) return cached;
  const inputDeltas = node.inputs.map(inp => evaluate(inp, memo));
  const out = node.step(inputDeltas);
  memo.set(node, out);
  return out;
}
