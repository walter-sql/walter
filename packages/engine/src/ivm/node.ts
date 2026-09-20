import type { Row, ZSet } from "./zset";
import { emptyTupleZSet, tzAdd, type Tuple, type TupleZSet } from "./tuple";
import type { CompiledExpr, CompiledPredicate } from "../planner/compile";

export abstract class DataflowNode {
  abstract readonly inputs: DataflowNode[];
  abstract step(inputDeltas: TupleZSet[]): TupleZSet;
  get stateSize(): number {
    return 0;
  }
}

export class SourceNode extends DataflowNode {
  override readonly inputs: DataflowNode[] = [];
  pending: TupleZSet = emptyTupleZSet();

  constructor(
    readonly alias: string,
    readonly table: string,
    readonly columns: readonly string[]
  ) {
    super();
  }

  load(physicalDelta: ZSet): TupleZSet {
    const out = emptyTupleZSet();
    for (const { row, weight } of physicalDelta.values()) {
      const t = this.columns.map(c => {
        const v = row[c];
        return v === undefined ? null : v;
      });
      tzAdd(out, t, weight);
    }
    return out;
  }

  override step(): TupleZSet {
    return this.pending;
  }
}

export class FilterNode extends DataflowNode {
  override readonly inputs: DataflowNode[];

  constructor(
    input: DataflowNode,
    private readonly predicate: CompiledPredicate
  ) {
    super();
    this.inputs = [input];
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const delta = inputDeltas[0]!;
    const out = emptyTupleZSet();
    for (const [k, e] of delta) {
      if (this.predicate(e.t)) out.set(k, e);
    }
    return out;
  }
}

export class ProjectNode extends DataflowNode {
  override readonly inputs: DataflowNode[];

  constructor(
    input: DataflowNode,
    private readonly exprs: readonly CompiledExpr[]
  ) {
    super();
    this.inputs = [input];
  }

  override step(inputDeltas: TupleZSet[]): TupleZSet {
    const delta = inputDeltas[0]!;
    const out = emptyTupleZSet();
    for (const { t, weight } of delta.values()) {
      tzAdd(
        out,
        this.exprs.map(f => f(t)),
        weight
      );
    }
    return out;
  }
}

export function tupleToRow(t: Tuple, names: readonly string[]): Row {
  const out: Row = {};
  for (let i = 0; i < names.length; i++) out[names[i]!] = t[i];
  return out;
}
