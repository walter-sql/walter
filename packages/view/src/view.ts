import type {
  CollectionOp,
  ElementOp,
  OrderMove,
  RowValue,
  ViewMessage
} from "./protocol";

export type ViewStatus = "pending" | "live" | "failed";

export interface View<TRow extends RowValue = RowValue> {
  readonly rows: TRow[];
  readonly status: ViewStatus;
}

export const pendingView: View<never> = { rows: [], status: "pending" };

export function applyView<TRow extends RowValue>(
  view: View<TRow>,
  msg: ViewMessage<TRow>
): View<TRow> {
  switch (msg.type) {
    case "snapshot":
      return { rows: msg.rows, status: "live" };
    case "diff":
      return { ...view, rows: applyCollection(view.rows, msg.changes) };
    case "failed":
      return { ...view, status: "failed" };
  }
}

// Phase order: updates, removes (descending), adds, reorder - keeps pre-diff indices valid.
export function applyCollection<T extends RowValue>(
  arr: readonly T[],
  ops: readonly CollectionOp<T>[]
): T[] {
  let out: T[] | undefined;
  const mut = (): T[] => out ?? (out = arr.slice());

  for (const op of ops)
    if (op.op === "update") {
      const cur = (out ?? arr)[op.index]!;
      const next = applyElement(cur, op.ops);
      if (next !== cur) mut()[op.index] = next;
    }
  const removals: number[] = [];
  for (const op of ops) if (op.op === "remove") removals.push(op.index);
  if (removals.length > 0)
    for (const i of removals.sort((a, b) => b - a)) mut().splice(i, 1);
  for (const op of ops) if (op.op === "add") mut().push(op.value);
  for (const op of ops)
    if (op.op === "reorder" && op.moves.length > 0)
      out = reorder(out ?? arr, op.moves);

  return out ?? (arr as T[]);
}

function applyElement<T extends RowValue>(el: T, ops: readonly ElementOp[]): T {
  let next: RowValue | undefined;
  for (const op of ops) {
    const cur = next ?? el;
    const value =
      op.op === "nest"
        ? applyCollection(asArray(cur[op.field]), op.ops)
        : op.op === "patch"
          ? applyElement((cur[op.field] ?? {}) as RowValue, op.ops)
          : op.value;
    if (value !== cur[op.field]) next = { ...cur, [op.field]: value };
  }
  return (next ?? el) as T;
}

function reorder<T>(items: readonly T[], moves: OrderMove[]): T[] {
  if (moves.length === 0) return items.slice();
  const moved = new Set(moves.map(m => m.from));
  const rest = items.filter((_, i) => !moved.has(i));
  for (const { from, to } of [...moves].sort((a, b) => a.to - b.to))
    rest.splice(to, 0, items[from]!);
  return rest;
}

function asArray(v: unknown): RowValue[] {
  return Array.isArray(v) ? (v as RowValue[]) : [];
}
