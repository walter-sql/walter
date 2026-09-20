import type { Scalar } from "../ivm/zset";
import type { CastTarget } from "./pgtypes";

export type ComparisonOp = "=" | "<>" | "<" | "<=" | ">" | ">=";
export type ArithOp = "+" | "-" | "*" | "/" | "%";
export type TextOp = "like" | "ilike";
export type BinaryOp = ComparisonOp | ArithOp | TextOp;

export const AGG_FUNCS = ["count", "sum", "avg", "min", "max"] as const;
export type AggFunc = (typeof AGG_FUNCS)[number];

export const SCALAR_FUNCS = [
  "lower",
  "upper",
  "concat",
  "length",
  "char_length",
  "abs",
  "round"
] as const;
export type ScalarFunc = (typeof SCALAR_FUNCS)[number];

export const WHOLE_ROW_FUNCS = ["to_json", "to_jsonb", "row_to_json"] as const;
export type WholeRowFunc = (typeof WHOLE_ROW_FUNCS)[number];

export type PgClass =
  | "int2"
  | "int"
  | "int8"
  | "float4"
  | "float"
  | "numeric"
  | "text"
  | "bool"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "uuid"
  | "bytea";

export type Expr =
  | { kind: "column"; table?: string; name: string; ptype?: PgClass }
  | { kind: "star"; table?: string; ptype?: PgClass }
  | { kind: "literal"; value: Scalar; ptype?: PgClass; quoted?: true }
  | { kind: "param"; index: number; ptype?: PgClass }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; ptype?: PgClass }
  | { kind: "neg"; operand: Expr; ptype?: PgClass }
  | { kind: "and"; items: Expr[]; ptype?: PgClass }
  | { kind: "or"; items: Expr[]; ptype?: PgClass }
  | { kind: "not"; operand: Expr; ptype?: PgClass }
  | { kind: "isNull"; operand: Expr; negated: boolean; ptype?: PgClass }
  | {
      kind: "in";
      operand: Expr;
      list: Expr[];
      negated: boolean;
      ptype?: PgClass;
    }
  | {
      kind: "anyParam";
      operand: Expr;
      param: number;
      negated: boolean;
      ptype?: PgClass;
    }
  | { kind: "wholeRow"; func: WholeRowFunc; arg: Expr; ptype?: PgClass }
  | { kind: "coalesce"; args: Expr[]; ptype?: PgClass }
  | { kind: "cast"; operand: Expr; to: CastTarget; ptype?: PgClass }
  | { kind: "func"; name: ScalarFunc; args: Expr[]; ptype?: PgClass }
  | {
      kind: "jsonBuildObject";
      pairs: { key: string; value: Expr }[];
      ptype?: PgClass;
    }
  | {
      kind: "jsonAgg";
      arg: Expr;
      orderBy?: OrderItem[];
      filter?: Expr;
      ptype?: PgClass;
    }
  | {
      kind: "aggregate";
      func: AggFunc;
      arg?: Expr;
      distinct: boolean;
      filter?: Expr;
      ptype?: PgClass;
    }
  | { kind: "exists"; subquery: Query; negated: boolean; ptype?: PgClass }
  | { kind: "scalarSubquery"; subquery: Query; ptype?: PgClass };

export interface SelectItem {
  expr: Expr;
  alias: string;
}

export interface OrderItem {
  expr: Expr;
  desc: boolean;
  nullsFirst: boolean;
}

export type FromItem =
  | { kind: "table"; name: string; schema?: string; alias: string }
  | {
      kind: "join";
      joinType: "inner" | "left";
      left: FromItem;
      right: FromItem;
      on: Expr;
    }
  | { kind: "subquery"; query: Query; alias: string; lateral: boolean };

export type Limit = number | { param: number };

export interface Query {
  from: FromItem;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  select: SelectItem[];
  distinct: boolean;
  orderBy: OrderItem[];
  limit?: Limit;
  offset?: Limit;
}

export interface CollectionSpec {
  field: string;
  parentKey: string[];
  childKey: string[];
  object: boolean;
  node: ShapeQuery;
}

export interface ShapeQuery {
  query: Query;
  collections: CollectionSpec[];
}

export function forEachChild(e: Expr, fn: (child: Expr) => void): void {
  switch (e.kind) {
    case "binary":
      fn(e.left);
      fn(e.right);
      return;
    case "neg":
    case "not":
    case "cast":
    case "isNull":
      fn(e.operand);
      return;
    case "and":
    case "or":
      for (const item of e.items) fn(item);
      return;
    case "in":
      fn(e.operand);
      for (const item of e.list) fn(item);
      return;
    case "anyParam":
      fn(e.operand);
      return;
    case "wholeRow":
      fn(e.arg);
      return;
    case "coalesce":
    case "func":
      for (const a of e.args) fn(a);
      return;
    case "jsonBuildObject":
      for (const p of e.pairs) fn(p.value);
      return;
    case "jsonAgg":
      fn(e.arg);
      for (const o of e.orderBy ?? []) fn(o.expr);
      if (e.filter) fn(e.filter);
      return;
    case "aggregate":
      if (e.arg) fn(e.arg);
      if (e.filter) fn(e.filter);
      return;
    case "column":
    case "star":
    case "literal":
    case "param":
    case "exists":
    case "scalarSubquery":
      return;
  }
}

export function forEachExpr(e: Expr, fn: (e: Expr) => boolean | void): void {
  if (fn(e) === false) return;
  forEachChild(e, c => forEachExpr(c, fn));
}

export function mapChildren(e: Expr, fn: (child: Expr) => Expr): Expr {
  switch (e.kind) {
    case "binary":
      return { ...e, left: fn(e.left), right: fn(e.right) };
    case "neg":
    case "not":
    case "cast":
    case "isNull":
      return { ...e, operand: fn(e.operand) };
    case "and":
    case "or":
      return { ...e, items: e.items.map(fn) };
    case "in":
      return { ...e, operand: fn(e.operand), list: e.list.map(fn) };
    case "anyParam":
      return { ...e, operand: fn(e.operand) };
    case "wholeRow":
      return { ...e, arg: fn(e.arg) };
    case "coalesce":
    case "func":
      return { ...e, args: e.args.map(fn) };
    case "jsonBuildObject":
      return {
        ...e,
        pairs: e.pairs.map(p => ({ key: p.key, value: fn(p.value) }))
      };
    case "jsonAgg":
      return {
        ...e,
        arg: fn(e.arg),
        orderBy: e.orderBy?.map(o => ({ ...o, expr: fn(o.expr) })),
        filter: e.filter ? fn(e.filter) : undefined
      };
    case "aggregate":
      return {
        ...e,
        arg: e.arg ? fn(e.arg) : undefined,
        filter: e.filter ? fn(e.filter) : undefined
      };
    case "column":
    case "star":
    case "literal":
    case "param":
    case "exists":
    case "scalarSubquery":
      return e;
  }
}

export class UnsupportedSqlError extends Error {
  override readonly name = "UnsupportedSqlError";
}

export class SqlParseError extends Error {
  override readonly name = "SqlParseError";
}

export class SqlEvalError extends Error {
  override readonly name = "SqlEvalError";
}

export function collectTables(
  from: FromItem,
  out: { name: string; alias: string }[] = []
): { name: string; alias: string }[] {
  if (from.kind === "table") {
    out.push({ name: from.name, alias: from.alias });
  } else if (from.kind === "subquery") {
    collectTables(from.query.from, out);
  } else {
    collectTables(from.left, out);
    collectTables(from.right, out);
  }
  return out;
}

export function qualifiedTable(
  schema: string | undefined,
  name: string,
  defaultSchema: string
): string {
  return `${quotePart(schema ?? defaultSchema)}.${quotePart(name)}`;
}

const BARE = /^[a-z_][a-z0-9_]*$/;
const PART = `"(?:[^"]|"")*"|[^".]+`;
const QUALIFIED = new RegExp(`^(${PART})(?:\\.(${PART}))?$`);

function quotePart(part: string): string {
  return BARE.test(part) ? part : `"${part.replaceAll('"', '""')}"`;
}

export function splitQualified(text: string): {
  schema?: string;
  name: string;
} {
  const m = QUALIFIED.exec(text);
  if (!m)
    throw new Error(
      `invalid table name ${JSON.stringify(text)}: quote parts SQL-style ("some.schema".tbl)`
    );
  return m[2] === undefined
    ? { name: unquotePart(m[1]!) }
    : { schema: unquotePart(m[1]!), name: unquotePart(m[2]!) };
}

function unquotePart(part: string): string {
  return part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part;
}

export function ownExprRoots(query: Query): Expr[] {
  const roots: (Expr | undefined)[] = [
    query.where,
    query.having,
    ...query.select.map(s => s.expr),
    ...query.groupBy,
    ...query.orderBy.map(o => o.expr)
  ];
  const ons = (f: FromItem): void => {
    if (f.kind === "join") {
      roots.push(f.on);
      ons(f.left);
      ons(f.right);
    }
  };
  ons(query.from);
  return roots.filter((e): e is Expr => e !== undefined);
}

export function visitQueries(query: Query, fn: (q: Query) => void): void {
  fn(query);
  const fromQueries = (f: FromItem): void => {
    if (f.kind === "subquery") visitQueries(f.query, fn);
    else if (f.kind === "join") {
      fromQueries(f.left);
      fromQueries(f.right);
    }
  };
  fromQueries(query.from);
  const exprQueries = (e: Expr): void => {
    if (e.kind === "exists" || e.kind === "scalarSubquery") {
      visitQueries(e.subquery, fn);
      return;
    }
    forEachChild(e, exprQueries);
  };
  for (const e of ownExprRoots(query)) exprQueries(e);
}

export function qualifyTableNames(query: Query, defaultSchema: string): void {
  visitQueries(query, q => qualifyFromTables(q.from, defaultSchema));
}

function qualifyFromTables(from: FromItem, defaultSchema: string): void {
  if (from.kind === "table") {
    from.name = qualifiedTable(from.schema, from.name, defaultSchema);
    from.schema = undefined;
  } else if (from.kind === "join") {
    qualifyFromTables(from.left, defaultSchema);
    qualifyFromTables(from.right, defaultSchema);
  }
}
