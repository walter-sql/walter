import { UnsupportedSqlError, forEachExpr, ownExprRoots } from "../parser/ir";
import type { Expr, PgClass, Query } from "../parser/ir";
import {
  PG_CLASS_NAME,
  SORT_OF,
  type CastTarget,
  type SortClass
} from "../parser/pgtypes";

export type ColumnResolver = (
  alias: string,
  column: string
) => PgClass | undefined;

export function threadQueryTypes(query: Query, resolve: ColumnResolver): void {
  for (const r of ownExprRoots(query)) threadExpr(r, resolve);
}

export function threadExpr(
  expr: Expr,
  resolve: ColumnResolver
): PgClass | undefined {
  switch (expr.kind) {
    case "column":
      if (expr.table === undefined) {
        throw new UnsupportedSqlError(
          `column "${expr.name}" does not exist; qualify references to outer tables`
        );
      }
      return (expr.ptype ??= resolve(expr.table, expr.name));
    case "literal":
      return expr.ptype;
    case "param":
      return expr.ptype;
    case "cast": {
      threadExpr(expr.operand, resolve);
      const to = expr.to;
      if (coercible(expr.operand)) coerceUnknown(expr.operand, to);
      else guardCast(to, expr.operand.ptype);
      return (expr.ptype = to);
    }
    case "neg": {
      threadExpr(expr.operand, resolve);
      return (expr.ptype = operatorClass("-", expr.operand));
    }
    case "binary": {
      threadExpr(expr.left, resolve);
      threadExpr(expr.right, resolve);
      switch (expr.op) {
        case "+":
        case "-":
        case "*":
        case "/":
        case "%": {
          const cls = operatorClass(expr.op, expr.left, expr.right);
          if ((expr.op === "/" || expr.op === "%") && cls === "numeric") {
            throw new UnsupportedSqlError(
              `operator ${expr.op} on numeric is not supported: Postgres ` +
                "selects the result scale via internal rules Walter does not " +
                "reproduce. Cast to ::float8 to opt into approximation."
            );
          }
          if (expr.op === "%" && (cls === "float" || cls === "float4")) {
            throw new UnsupportedSqlError(
              "operator does not exist: double precision % double precision " +
                "(an error in Postgres too); cast to ::numeric"
            );
          }
          return (expr.ptype = cls);
        }
        case "=":
        case "<>":
        case "<":
        case "<=":
        case ">":
        case ">=":
          comparisonClass(expr.left, expr.right);
          coerceComparison(expr.left, expr.right);
          return (expr.ptype = "bool");
        default:
          return (expr.ptype = "bool");
      }
    }
    case "coalesce": {
      const classes = expr.args.map(a => threadExpr(a, resolve));
      return (expr.ptype = commonClass(classes));
    }
    case "func": {
      const argClasses = expr.args.map(a => threadExpr(a, resolve));
      return (expr.ptype = funcClass(expr, argClasses));
    }
    case "and":
    case "or":
      for (const i of expr.items) threadExpr(i, resolve);
      return (expr.ptype = "bool");
    case "not":
    case "isNull":
      threadExpr(expr.operand, resolve);
      return (expr.ptype = "bool");
    case "in": {
      threadExpr(expr.operand, resolve);
      for (const i of expr.list) threadExpr(i, resolve);
      const { target, sites } = inListClass(expr.operand, expr.list);
      const opTarget = target ?? sites[0];
      if (opTarget !== undefined) coerceUnknown(expr.operand, opTarget);
      if (target !== undefined)
        for (const i of expr.list) coerceUnknown(i, target);
      return (expr.ptype = "bool");
    }
    case "anyParam":
      throw new UnsupportedSqlError(
        "ANY/ALL param must be folded before planning"
      );
    case "jsonBuildObject":
      for (const p of expr.pairs) threadExpr(p.value, resolve);
      return undefined;
    case "jsonAgg":
      threadExpr(expr.arg, resolve);
      if (expr.filter) threadExpr(expr.filter, resolve);
      for (const o of expr.orderBy ?? []) threadExpr(o.expr, resolve);
      return undefined;
    case "aggregate": {
      if (expr.arg) threadExpr(expr.arg, resolve);
      if (expr.filter) threadExpr(expr.filter, resolve);
      if (expr.arg && expr.func !== "count") {
        if (coercible(expr.arg)) {
          if (expr.func === "min" || expr.func === "max") {
            coerceUnknown(expr.arg, "text");
          } else {
            throw new UnsupportedSqlError(
              `function ${expr.func}(unknown) is not unique ` +
                "(an error in Postgres too); cast the argument"
            );
          }
        } else if (
          expr.arg.ptype === undefined ||
          ((expr.func === "sum" || expr.func === "avg") &&
            !NUMERIC.has(expr.arg.ptype))
        ) {
          const c = expr.arg.ptype;
          throw new UnsupportedSqlError(
            c === undefined
              ? `${expr.func}() over an unsupported column type; cast the column explicitly`
              : `function ${expr.func}(${PG_CLASS_NAME[c]}) does not exist ` +
                  "(an error in Postgres too)"
          );
        }
      }
      const argClass = expr.arg?.ptype;
      if (expr.func === "sum" && argClass === "float4") {
        throw new UnsupportedSqlError(
          "sum over real is not supported: Postgres accumulates it in single " +
            "precision, so the result depends on scan order, not just the " +
            "data. Cast to ::float8 for the well-defined sum."
        );
      }
      if (
        expr.func === "avg" &&
        argClass !== undefined &&
        argClass !== "float" &&
        argClass !== "float4" &&
        NUMERIC.has(argClass)
      ) {
        throw new UnsupportedSqlError(
          "avg over an exact numeric type (numeric/int/bigint) is not " +
            "supported: it divides, and Postgres selects the result scale via " +
            "internal rules Walter does not reproduce. Cast to ::float8 to opt " +
            "into approximation, or compute sum(...) and count(...) separately."
        );
      }
      switch (expr.func) {
        case "count":
          return (expr.ptype = "int8");
        case "sum":
          return (expr.ptype =
            argClass === "int" || argClass === "int2"
              ? "int8"
              : argClass === "int8"
                ? "numeric"
                : argClass);
        case "min":
        case "max":
          return (expr.ptype = argClass);
        case "avg":
          return (expr.ptype = "float");
      }
    }
    case "exists":
      return "bool";
    case "scalarSubquery":
      return undefined;
    case "star":
    case "wholeRow":
      throw new UnsupportedSqlError(
        `${expr.kind} must be expanded before planning`
      );
    default: {
      const _exhaustive: never = expr;
      void _exhaustive;
      return undefined;
    }
  }
}

const NUMERIC: ReadonlySet<PgClass> = new Set([
  "int2",
  "int",
  "int8",
  "float4",
  "float",
  "numeric"
]);

const CONCAT_CLASSES: ReadonlySet<PgClass> = new Set([
  "text",
  "int2",
  "int",
  "int8",
  "numeric",
  "bool",
  "date",
  "timestamp",
  "timestamptz",
  "uuid",
  "bytea"
]);

function guardCast(to: CastTarget, oc: PgClass | undefined): void {
  const reject = (from: PgClass | undefined): never => {
    if (from === undefined) {
      throw new UnsupportedSqlError(
        `::${to} cast requires an operand of known type; ` +
          "declare param types as $n::type and cast columns explicitly"
      );
    }
    throw new UnsupportedSqlError(
      `cannot cast type ${PG_CLASS_NAME[from]} to ${PG_CLASS_NAME[to]} ` +
        "(an error in Postgres too)"
    );
  };
  switch (to) {
    case "int2":
    case "int":
    case "int8": {
      if (oc === "bool") {
        if (to === "int") return;
        reject(oc);
      }
      if (oc === undefined || !NUMERIC.has(oc)) {
        throw new UnsupportedSqlError(
          `::${to} cast requires a numeric operand of known type ` +
            "(declare param types as $n::int, or cast columns to ::numeric first)"
        );
      }
      return;
    }
    case "float": {
      if (oc !== undefined && NUMERIC.has(oc)) return;
      if (oc === "text") {
        throw new UnsupportedSqlError(
          "casting text to float8 is not supported (float8's input grammar " +
            "is not reproduced exactly); cast to ::numeric instead"
        );
      }
      return reject(oc);
    }
    case "numeric": {
      if (oc === "text" || (oc !== undefined && NUMERIC.has(oc))) return;
      return reject(oc);
    }
    case "bool": {
      if (oc === "bool" || oc === "int" || oc === "text") return;
      return reject(oc);
    }
    case "text": {
      if (oc !== undefined && CONCAT_CLASSES.has(oc)) return;
      if (oc === "float" || oc === "float4") {
        throw new UnsupportedSqlError(
          "casting float to text is not supported: Postgres float text " +
            "(1e+20) is not reproducible; cast to ::numeric first"
        );
      }
      return reject(oc);
    }
    case "uuid":
    case "date":
    case "timestamp":
    case "timestamptz": {
      if (oc === to) return;
      throw new UnsupportedSqlError(
        `::${to} requires a ${to} operand or a constant ` +
          "(Postgres parses arbitrary text per row, converting to " +
          "timestamptz through the session timezone; Walter cannot " +
          "reproduce either)"
      );
    }
    default: {
      const _exhaustive: never = to;
      void _exhaustive;
    }
  }
}

function funcClass(
  expr: Extract<Expr, { kind: "func" }>,
  argClasses: (PgClass | undefined)[]
): PgClass {
  const { name, args } = expr;
  const arity = (min: number, max: number): void => {
    if (args.length < min || args.length > max) {
      throw new UnsupportedSqlError(
        `${name}() takes ${min === max ? String(min) : `${min} to ${max}`} ` +
          `argument(s), got ${args.length}`
      );
    }
  };
  const arg = (
    i: number,
    allowed: readonly PgClass[],
    as: PgClass
  ): PgClass => {
    const e = args[i]!;
    if (coercible(e)) {
      coerceUnknown(e, as);
      return as;
    }
    const c = argClasses[i];
    if (c !== undefined && allowed.includes(c)) return c;
    throw new UnsupportedSqlError(
      `function ${name}(${c ?? "unsupported type"}) does not exist in ` +
        "Postgres; cast the argument explicitly"
    );
  };
  switch (name) {
    case "lower":
    case "upper":
      arity(1, 1);
      arg(0, ["text"], "text");
      return "text";
    case "length":
      arity(1, 1);
      arg(0, ["text", "bytea"], "text");
      return "int";
    case "char_length":
      arity(1, 1);
      arg(0, ["text"], "text");
      return "int";
    case "concat": {
      if (args.length === 0)
        throw new UnsupportedSqlError("concat() takes at least one argument");
      for (let i = 0; i < args.length; i++) {
        if (coercible(args[i]!)) {
          coerceUnknown(args[i]!, "text");
          continue;
        }
        const c = argClasses[i];
        if (c === undefined || !CONCAT_CLASSES.has(c)) {
          throw new UnsupportedSqlError(
            c === "float" || c === "float4"
              ? "concat over float is not supported: Postgres float text " +
                  "(1e+20) is not reproducible; cast to ::numeric first"
              : `concat over ${c ?? "an unsupported type"} is not supported`
          );
        }
      }
      return "text";
    }
    case "abs":
      arity(1, 1);
      return arg(
        0,
        ["int2", "int", "int8", "float4", "float", "numeric"],
        "float"
      );
    case "round": {
      arity(1, 2);
      if (args.length === 1) {
        const c = arg(
          0,
          ["int2", "int", "int8", "numeric", "float4", "float"],
          "float"
        );
        return c === "float" || c === "float4" ? "float" : "numeric";
      }
      if (argClasses[0] === "float" || argClasses[0] === "float4") {
        throw new UnsupportedSqlError(
          "round(float8, int) does not exist in Postgres " +
            "(only round(numeric, int)); cast to ::numeric first"
        );
      }
      arg(0, ["int2", "int", "int8", "numeric"], "numeric");
      arg(1, ["int2", "int"], "int");
      return "numeric";
    }
    default: {
      const _exhaustive: never = name;
      throw new UnsupportedSqlError(`unknown function ${String(_exhaustive)}`);
    }
  }
}

function coercible(e: Expr): e is Extract<Expr, { kind: "param" | "literal" }> {
  if (e.kind === "param") return e.ptype === undefined;
  if (e.kind !== "literal") return false;
  if (e.value === null) return true;
  return (
    typeof e.value === "string" && (e.ptype === "text" || e.ptype === undefined)
  );
}

function operatorClass(op: string, ...operands: Expr[]): PgClass {
  const shape = (names: string[]): string =>
    names.length === 2 ? `${names[0]} ${op} ${names[1]}` : `${op} ${names[0]}`;
  const known = operands.filter(e => !coercible(e));
  if (known.length === 0) {
    throw new UnsupportedSqlError(
      `operator is not unique: ${shape(operands.map(() => "unknown"))} ` +
        "(an error in Postgres too); cast at least one side"
    );
  }
  const classes: PgClass[] = [];
  for (const e of known) {
    const c = e.ptype;
    if (c === undefined) {
      throw new UnsupportedSqlError(
        `operator ${op} over an unsupported column type; cast the column explicitly`
      );
    }
    if (SORT_OF[c] === "time" && operands.length === 2) {
      throw new UnsupportedSqlError(
        `${PG_CLASS_NAME[c]} arithmetic is not supported; ` +
          "compute date/time math in the application"
      );
    }
    if (!NUMERIC.has(c)) {
      throw new UnsupportedSqlError(
        `operator does not exist: ` +
          `${shape(operands.map(s => PG_CLASS_NAME[s.ptype ?? c]))} ` +
          "(an error in Postgres too)"
      );
    }
    classes.push(c);
  }
  const cls = classes.reduce(promoteNumeric);
  for (const e of operands) coerceUnknown(e, cls);
  return cls;
}

function coerceUnknown(e: Expr, cls: PgClass): void {
  if (coercible(e)) e.ptype = cls;
}

function coerceComparison(l: Expr, r: Expr): void {
  const lu = coercible(l);
  const ru = coercible(r);
  if (lu && ru) {
    coerceUnknown(l, "text");
    coerceUnknown(r, "text");
  } else if (lu) coerceUnknown(l, r.ptype!);
  else if (ru) coerceUnknown(r, l.ptype!);
}

function operandClass(e: Expr): PgClass | "unknown" {
  if (coercible(e)) return "unknown";
  if (e.ptype === undefined) {
    throw new UnsupportedSqlError(
      "cannot compare a value whose type Walter does not support " +
        "(unsupported column type or untypeable expression); cast it explicitly"
    );
  }
  return e.ptype;
}

export function comparisonClass(left: Expr, right: Expr): SortClass {
  return classSort(operandClass(left), operandClass(right));
}

function classSort(l: PgClass | "unknown", r: PgClass | "unknown"): SortClass {
  if (l === "unknown") return r === "unknown" ? "text" : SORT_OF[r];
  if (r === "unknown") return SORT_OF[l];
  if (l === r) return SORT_OF[l];
  if (NUMERIC.has(l) && NUMERIC.has(r)) return "number";
  if (SORT_OF[l] === "time" && SORT_OF[r] === "time") {
    if ((l === "timestamptz") !== (r === "timestamptz")) {
      throw new UnsupportedSqlError(
        `cannot compare ${l} with ${r} faithfully: Postgres converts through ` +
          "the session timezone; compare against a zoned bound instead"
      );
    }
    return "time";
  }
  throw new UnsupportedSqlError(
    `cannot compare ${l} with ${r} (an error in Postgres too); ` +
      "cast one side explicitly"
  );
}

export function inListClass(
  operand: Expr,
  list: readonly Expr[]
): { cls: SortClass; target: PgClass | undefined; sites: PgClass[] } {
  const constants = list.filter(i => !hasColumnRef(i));
  const pool = [operand, ...constants];
  const typedPool = pool
    .map(operandClass)
    .filter((c): c is PgClass => c !== "unknown");
  for (let i = 1; i < typedPool.length; i++)
    classSort(typedPool[0]!, typedPool[i]!);
  const target = typedPool.length
    ? commonClass(typedPool)
    : constants.length > 0
      ? "text"
      : undefined;

  const sites: PgClass[] = target !== undefined ? [target] : [];
  for (const item of list) {
    if (constants.includes(item)) continue;
    const c = operandClass(item);
    if (c !== "unknown" && !sites.includes(c)) sites.push(c);
  }
  if (operand.kind === "param" && coercible(operand) && sites.length > 1) {
    throw new UnsupportedSqlError(
      `inconsistent types for parameter $${operand.index} in IN list ` +
        `(${sites.join(" versus ")}); cast it or the columns to one type`
    );
  }
  let cls: SortClass = sites.length ? SORT_OF[sites[0]!] : "text";
  for (let i = 1; i < sites.length; i++) cls = classSort(sites[0]!, sites[i]!);
  return { cls, target, sites };
}

function hasColumnRef(e: Expr): boolean {
  let found = false;
  forEachExpr(e, n => {
    if (
      n.kind === "column" ||
      n.kind === "exists" ||
      n.kind === "scalarSubquery"
    )
      found = true;
  });
  return found;
}

function promoteNumeric(a: PgClass, b: PgClass): PgClass {
  if (a === "float" || b === "float") return "float";
  if (a === "float4" || b === "float4") return a === b ? "float4" : "float";
  if (a === "numeric" || b === "numeric") return "numeric";
  if (a === "int8" || b === "int8") return "int8";
  if (a === "int" || b === "int") return "int";
  return "int2";
}

function commonClass(classes: (PgClass | undefined)[]): PgClass | undefined {
  const defined = classes.filter((c): c is PgClass => c !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.every(c => c === defined[0])) return defined[0];
  if (defined.every(c => c === "date" || c === "timestamp")) return "timestamp";
  if (defined.every(c => NUMERIC.has(c))) return defined.reduce(promoteNumeric);
  return undefined;
}
