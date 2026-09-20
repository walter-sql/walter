import type { BinaryOp, ComparisonOp, Expr, PgClass } from "../parser/ir";
import { SqlEvalError, UnsupportedSqlError } from "../parser/ir";
import { inputValue } from "../parser/pgtypes";
import {
  applyBinary,
  applyCast,
  applyFunc,
  applyNeg,
  compareClassValues,
  compareFloatResolved,
  isNull,
  likeMatcher,
  type Params
} from "../parser/eval";
import { canonicalize, type Row } from "../ivm/zset";
import type { Tuple } from "../ivm/tuple";
import type { Layout } from "./layout";
import { comparisonClass, inListClass } from "./types";
import { splitAnd } from "./exprutil";

export type CompiledExpr<Env = Tuple> = (env: Env) => unknown;
export type CompiledPredicate<Env = Tuple> = (env: Env) => boolean;

type ColumnAccessor<Env> = (
  table: string | undefined,
  name: string
) => CompiledExpr<Env>;

export function compileExpr(
  expr: Expr,
  layout: Layout,
  params: Params
): CompiledExpr {
  return compile<Tuple>(
    expr,
    (table, name) => {
      const idx = layout.resolve(table, name);
      return t => {
        const v = t[idx];
        return v === undefined ? null : v;
      };
    },
    params
  );
}

export function compilePredicate(
  expr: Expr,
  layout: Layout,
  params: Params
): CompiledPredicate {
  return qual(expr, e => compileExpr(e, layout, params));
}

function qual<Env>(
  expr: Expr,
  compileOne: (e: Expr) => CompiledExpr<Env>
): CompiledPredicate<Env> {
  const conjuncts = splitAnd(expr);
  if (conjuncts.length === 0) return () => true;
  if (conjuncts.length === 1) {
    const f = compileOne(conjuncts[0]!);
    return t => f(t) === true;
  }
  const items = conjuncts.map(compileOne);
  return t => {
    let pass = true;
    let err: unknown;
    for (const item of items) {
      let v: unknown;
      try {
        v = item(t);
      } catch (e) {
        if (!(e instanceof SqlEvalError)) throw e;
        err ??= e;
        continue;
      }
      if (v === false) return false;
      if (v === null || v === undefined) pass = false;
    }
    if (!pass) return false;
    if (err !== undefined) throw err;
    return true;
  };
}

export function compileRowExpr(expr: Expr, params: Params): CompiledExpr<Row> {
  return compile<Row>(
    expr,
    (_table, name) => r => {
      const v = r[name];
      return v === undefined ? null : v;
    },
    params
  );
}

export function compileRowPredicate(
  expr: Expr,
  params: Params
): CompiledPredicate<Row> {
  return qual(expr, e => compileRowExpr(e, params));
}

export type AliasRows = Record<string, Row | undefined>;

export function compileAliasExpr(
  expr: Expr,
  params: Params
): CompiledExpr<AliasRows> {
  return compile<AliasRows>(
    expr,
    (table, name) => env => {
      const v = table === undefined ? undefined : env[table]?.[name];
      return v === undefined ? null : v;
    },
    params
  );
}

export function compileAliasPredicate(
  expr: Expr,
  params: Params
): CompiledPredicate<AliasRows> {
  return qual(expr, e => compileAliasExpr(e, params));
}

function compile<Env>(
  expr: Expr,
  column: ColumnAccessor<Env>,
  params: Params
): CompiledExpr<Env> {
  const sub = (e: Expr): CompiledExpr<Env> => compile(e, column, params);
  switch (expr.kind) {
    case "column":
      return column(expr.table, expr.name);
    case "literal": {
      const v = constValue(expr.ptype, expr.value);
      return () => v;
    }
    case "param": {
      const v = constValue(
        expr.ptype,
        canonicalize(params[expr.index - 1] ?? null)
      );
      return () => v;
    }
    case "neg": {
      if (constNull(expr.operand, params)) return () => null;
      const operand = sub(expr.operand);
      const ptype = expr.ptype;
      return t => applyNeg(ptype, operand(t));
    }
    case "binary": {
      if (constNull(expr.left, params) || constNull(expr.right, params))
        return () => null;
      const op = expr.op;
      if (isComparisonOp(op)) {
        const cls = comparisonClass(expr.left, expr.right);
        const floatRes =
          cls === "number" &&
          (isFloatClass(expr.left.ptype) || isFloatClass(expr.right.ptype));
        const l = sub(expr.left);
        const r = sub(expr.right);
        const test = CMP_TESTS[op];
        return t => {
          const a = l(t);
          const b = r(t);
          if (isNull(a) || isNull(b)) return null;
          return test(
            floatRes
              ? compareFloatResolved(a, b)
              : compareClassValues(a, b, cls)
          );
        };
      }
      if (op === "like" || op === "ilike") {
        const ci = op === "ilike";
        const l = sub(expr.left);
        const pat = constantOf(expr.right, params);
        if (pat !== undefined) {
          if (pat === null) return () => null;
          const m = likeMatcher(String(pat), ci);
          return t => {
            const v = l(t);
            return isNull(v) ? null : m(String(v));
          };
        }
        const r = sub(expr.right);
        return t => {
          const a = l(t);
          const b = r(t);
          if (isNull(a) || isNull(b)) return null;
          return likeMatcher(String(b), ci)(String(a));
        };
      }
      const l = sub(expr.left);
      const r = sub(expr.right);
      const ptype = expr.ptype;
      return t => applyBinary(op, ptype, l(t), r(t));
    }
    case "and": {
      const items = expr.items.map(sub);
      return t => {
        let sawNull = false;
        for (const item of items) {
          const v = item(t);
          if (v === false) return false;
          if (v === null || v === undefined) sawNull = true;
        }
        return sawNull ? null : true;
      };
    }
    case "or": {
      const items = expr.items.map(sub);
      return t => {
        let sawNull = false;
        for (const item of items) {
          const v = item(t);
          if (v === true) return true;
          if (v === null || v === undefined) sawNull = true;
        }
        return sawNull ? null : false;
      };
    }
    case "not": {
      const operand = sub(expr.operand);
      return t => {
        const v = operand(t);
        if (v === null || v === undefined) return null;
        return !v;
      };
    }
    case "isNull": {
      const operand = sub(expr.operand);
      const negated = expr.negated;
      return t => {
        const n = isNull(operand(t));
        return negated ? !n : n;
      };
    }
    case "in": {
      if (expr.list.length === 0) {
        const negated = expr.negated;
        return () => negated;
      }
      const { cls, target, sites } = inListClass(expr.operand, expr.list);
      const opTarget = target ?? sites[0];
      const floatRes =
        cls === "number" &&
        (isFloatClass(expr.operand.ptype) ||
          isFloatClass(target) ||
          sites.some(isFloatClass) ||
          expr.list.some(i => isFloatClass(i.ptype)));
      if (expr.operand.kind === "literal") {
        for (const s of sites)
          if (s !== opTarget) inputValue(s, expr.operand.value);
      }
      const operand = sub(expr.operand);
      const list = expr.list.map(sub);
      const negated = expr.negated;
      return t => {
        const v = operand(t);
        if (isNull(v)) return null;
        let sawNull = false;
        for (const item of list) {
          const iv = item(t);
          if (isNull(iv)) {
            sawNull = true;
            continue;
          }
          const c = floatRes
            ? compareFloatResolved(v, iv)
            : compareClassValues(v, iv, cls);
          if (c === 0) return !negated;
        }
        if (sawNull) return null;
        return negated;
      };
    }
    case "coalesce": {
      const args = expr.args.map(sub);
      return t => {
        for (const a of args) {
          const v = a(t);
          if (!isNull(v)) return v;
        }
        return null;
      };
    }
    case "cast": {
      const operand = sub(expr.operand);
      const to = expr.to;
      const operandPtype = expr.operand.ptype;
      return t => applyCast(to, operandPtype, operand(t));
    }
    case "func": {
      const args = expr.args.map(sub);
      const name = expr.name;
      const ptypes = expr.args.map(a => a.ptype);
      return t =>
        applyFunc(
          name,
          args.map(a => a(t)),
          ptypes
        );
    }
    case "jsonBuildObject": {
      const pairs = expr.pairs.map(p => ({
        key: p.key,
        value: sub(p.value)
      }));
      return t => {
        const obj: Row = {};
        for (const p of pairs) obj[p.key] = p.value(t);
        return obj;
      };
    }
    case "jsonAgg":
    case "aggregate":
    case "exists":
    case "scalarSubquery":
    case "star":
    case "anyParam":
    case "wholeRow":
      throw new UnsupportedSqlError(
        `expression cannot be evaluated row-locally (kind=${expr.kind})`
      );
    default: {
      const _exhaustive: never = expr;
      throw new UnsupportedSqlError(
        `unknown expr ${(_exhaustive as Expr).kind}`
      );
    }
  }
}

const CMP_TESTS = {
  "=": (c: number) => c === 0,
  "<>": (c: number) => c !== 0,
  "<": (c: number) => c < 0,
  "<=": (c: number) => c <= 0,
  ">": (c: number) => c > 0,
  ">=": (c: number) => c >= 0
} as const;

function isComparisonOp(op: BinaryOp): op is ComparisonOp {
  return op in CMP_TESTS;
}

function isFloatClass(c: PgClass | undefined): boolean {
  return c === "float" || c === "float4";
}

function constantOf(e: Expr, params: Params): unknown {
  if (e.kind === "literal") return e.value;
  if (e.kind === "param") return params[e.index - 1] ?? null;
  return undefined;
}

function constNull(e: Expr, params: Params): boolean {
  return constantOf(e, params) === null;
}

function constValue(cls: PgClass | undefined, v: unknown): unknown {
  return cls === undefined ? v : inputValue(cls, v);
}
