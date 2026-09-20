import {
  forEachExpr,
  mapChildren,
  type Expr,
  type FromItem,
  type OrderItem
} from "../parser/ir";

export function exprEquals(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "column":
      return b.kind === "column" && a.table === b.table && a.name === b.name;
    case "literal":
      return (
        b.kind === "literal" &&
        Object.is(a.value, b.value) &&
        a.quoted === b.quoted
      );
    case "param":
      return b.kind === "param" && a.index === b.index;
    case "binary":
      return (
        b.kind === "binary" &&
        a.op === b.op &&
        exprEquals(a.left, b.left) &&
        exprEquals(a.right, b.right)
      );
    case "neg":
      return b.kind === "neg" && exprEquals(a.operand, b.operand);
    case "not":
      return b.kind === "not" && exprEquals(a.operand, b.operand);
    case "cast":
      return (
        b.kind === "cast" && a.to === b.to && exprEquals(a.operand, b.operand)
      );
    case "isNull":
      return (
        b.kind === "isNull" &&
        a.negated === b.negated &&
        exprEquals(a.operand, b.operand)
      );
    case "and":
      return b.kind === "and" && listEquals(a.items, b.items);
    case "or":
      return b.kind === "or" && listEquals(a.items, b.items);
    case "in":
      return (
        b.kind === "in" &&
        a.negated === b.negated &&
        exprEquals(a.operand, b.operand) &&
        listEquals(a.list, b.list)
      );
    case "coalesce":
      return b.kind === "coalesce" && listEquals(a.args, b.args);
    case "func":
      return (
        b.kind === "func" && a.name === b.name && listEquals(a.args, b.args)
      );
    case "jsonBuildObject":
      return (
        b.kind === "jsonBuildObject" &&
        a.pairs.length === b.pairs.length &&
        a.pairs.every(
          (p, i) =>
            p.key === b.pairs[i]!.key && exprEquals(p.value, b.pairs[i]!.value)
        )
      );
    case "jsonAgg":
      return (
        b.kind === "jsonAgg" &&
        exprEquals(a.arg, b.arg) &&
        optEquals(a.filter, b.filter) &&
        orderByEquals(a.orderBy, b.orderBy)
      );
    case "aggregate":
      return (
        b.kind === "aggregate" &&
        a.func === b.func &&
        a.distinct === b.distinct &&
        optEquals(a.arg, b.arg) &&
        optEquals(a.filter, b.filter)
      );
    case "exists":
      return false;
    default:
      return false;
  }
}

function listEquals(a: Expr[], b: Expr[]): boolean {
  return a.length === b.length && a.every((x, i) => exprEquals(x, b[i]!));
}

function optEquals(a: Expr | undefined, b: Expr | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return exprEquals(a, b);
}

function orderByEquals(a?: OrderItem[], b?: OrderItem[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every(
      (o, i) =>
        exprEquals(o.expr, b[i]!.expr) &&
        o.desc === b[i]!.desc &&
        o.nullsFirst === b[i]!.nullsFirst
    )
  );
}

export function splitAnd(expr: Expr | undefined): Expr[] {
  if (!expr) return [];
  if (expr.kind === "and") return expr.items.flatMap(splitAnd);
  if (expr.kind === "literal" && expr.value === true) return [];
  return [expr];
}

export function andAll(exprs: Expr[]): Expr | undefined {
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0];
  return { kind: "and", items: exprs };
}

export function referencedAliases(
  expr: Expr,
  set: Set<string>,
  sawBare: { v: boolean }
): void {
  forEachExpr(expr, e => {
    if (e.kind !== "column") return;
    if (e.table) set.add(e.table);
    else sawBare.v = true;
  });
}

export function referencesOnly(
  expr: Expr,
  aliases: ReadonlySet<string>
): boolean {
  const set = new Set<string>();
  const sawBare = { v: false };
  referencedAliases(expr, set, sawBare);
  if (sawBare.v) return false;
  for (const a of set) if (!aliases.has(a)) return false;
  return true;
}

export function correlationCoversChildKey(
  corrColumns: readonly string[],
  childKeys: readonly (readonly string[])[]
): boolean {
  return childKeys.some(
    key => key.length > 0 && key.every(c => corrColumns.includes(c))
  );
}

export type Column = Extract<Expr, { kind: "column" }>;

export function equiColumns(
  conj: Expr
): { left: Column; right: Column } | undefined {
  if (conj.kind !== "binary" || conj.op !== "=") return undefined;
  if (conj.left.kind !== "column" || conj.right.kind !== "column")
    return undefined;
  return { left: conj.left, right: conj.right };
}

export function orientBySides(
  left: Expr,
  right: Expr,
  aAliases: ReadonlySet<string>,
  bAliases: ReadonlySet<string>
): { a: Expr; b: Expr } | undefined {
  if (referencesOnly(left, aAliases) && referencesOnly(right, bAliases))
    return { a: left, b: right };
  if (referencesOnly(left, bAliases) && referencesOnly(right, aAliases))
    return { a: right, b: left };
  return undefined;
}

export function aliasesOf(
  from: FromItem,
  set = new Set<string>()
): Set<string> {
  if (from.kind === "table") set.add(from.alias);
  else if (from.kind === "subquery") set.add(from.alias);
  else {
    aliasesOf(from.left, set);
    aliasesOf(from.right, set);
  }
  return set;
}

export function nullableAliases(
  from: FromItem,
  out = new Set<string>(),
  underLeft = false
): Set<string> {
  if (from.kind === "table") {
    if (underLeft) out.add(from.alias);
  } else if (from.kind === "join") {
    nullableAliases(from.left, out, underLeft);
    nullableAliases(from.right, out, underLeft || from.joinType === "left");
  }
  return out;
}

export interface EquiKeyIR {
  left: Expr;
  right: Expr;
}

export function splitJoinCondition(
  on: Expr,
  leftAliases: ReadonlySet<string>,
  rightAliases: ReadonlySet<string>
): { equiKeys: EquiKeyIR[]; residual: Expr | undefined } {
  const equiKeys: EquiKeyIR[] = [];
  const residual: Expr[] = [];
  for (const conj of splitAnd(on)) {
    const pair = asEquiKey(conj, leftAliases, rightAliases);
    if (pair) equiKeys.push(pair);
    else residual.push(conj);
  }
  return { equiKeys, residual: andAll(residual) };
}

function asEquiKey(
  conj: Expr,
  leftAliases: ReadonlySet<string>,
  rightAliases: ReadonlySet<string>
): EquiKeyIR | undefined {
  const cols = equiColumns(conj);
  if (!cols) return undefined;
  const o = orientBySides(cols.left, cols.right, leftAliases, rightAliases);
  return o ? { left: o.a, right: o.b } : undefined;
}

export function collectUngroupedColumns(
  expr: Expr,
  groupExprs: readonly Expr[],
  out: Extract<Expr, { kind: "column" }>[]
): void {
  forEachExpr(expr, e => {
    if (groupExprs.some(g => exprEquals(g, e))) return false;
    if (e.kind === "aggregate" || e.kind === "jsonAgg") return false;
    if (e.kind === "column" && !out.some(o => exprEquals(o, e))) out.push(e);
  });
}

export function collectAggregates(expr: Expr, out: Expr[]): void {
  forEachExpr(expr, e => {
    if (e.kind !== "aggregate" && e.kind !== "jsonAgg") return;
    if (!out.some(o => exprEquals(o, e))) out.push(e);
    return false;
  });
}

export function hasAggregate(expr: Expr): boolean {
  const aggs: Expr[] = [];
  collectAggregates(expr, aggs);
  return aggs.length > 0;
}

export interface RewriteRule {
  match: Expr;
  replacement: Expr;
}

export function rewriteExpr(expr: Expr, rules: RewriteRule[]): Expr {
  for (const r of rules) if (exprEquals(expr, r.match)) return r.replacement;
  return mapChildren(expr, c => rewriteExpr(c, rules));
}
