import { loadModule, parseSync, hasSqlDetails } from "libpg-query";
import {
  AGG_FUNCS,
  SCALAR_FUNCS,
  SqlParseError,
  UnsupportedSqlError,
  WHOLE_ROW_FUNCS,
  forEachExpr,
  qualifyTableNames,
  type AggFunc,
  type BinaryOp,
  type Expr,
  type FromItem,
  type Limit,
  type OrderItem,
  type Query,
  type ScalarFunc,
  type SelectItem,
  type ShapeQuery,
  type WholeRowFunc
} from "./ir";
import { liftShape } from "./lift";
import { expandStars } from "./expand";
import type { SchemaCatalog } from "./catalog";
import type { Scalar } from "../ivm/zset";
import { canonNumeric } from "./decimal";
import { castTargetOf, parseBoolText } from "./pgtypes";

type PgNode = Record<string, any>;

let parserReady: Promise<void> | undefined;

export async function initParser(): Promise<void> {
  parserReady ??= loadModule();
  await parserReady;
}

const TRUE_EXPR: Expr = { kind: "literal", value: true, ptype: "bool" };

export async function parseSql(sql: string): Promise<Query> {
  await initParser();
  let tree: { stmts?: PgNode[] };
  try {
    tree = parseSync(sql) as { stmts?: PgNode[] };
  } catch (err) {
    if (hasSqlDetails(err)) {
      const d = err.sqlDetails;
      throw new SqlParseError(
        `${d.message}${
          d.cursorPosition !== undefined ? ` at ${d.cursorPosition}` : ""
        }`
      );
    }
    throw new SqlParseError(err instanceof Error ? err.message : String(err));
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) {
    throw new UnsupportedSqlError("exactly one statement is supported");
  }
  const stmt = stmts[0]!.stmt;
  if (!stmt || !("SelectStmt" in stmt)) {
    throw new UnsupportedSqlError("only SELECT statements are supported");
  }
  return convertSelect(stmt.SelectStmt);
}

export async function parseShapeSql(
  sql: string,
  catalog: SchemaCatalog,
  defaultSchema?: string
): Promise<ShapeQuery> {
  const query = await parseSql(sql);
  if (defaultSchema !== undefined) qualifyTableNames(query, defaultSchema);
  expandStars(query, catalog);
  return liftShape(query, catalog);
}

function tag(node: PgNode): string {
  const keys = Object.keys(node);
  if (keys.length !== 1)
    throw new SqlParseError(`malformed node with keys ${keys.join(",")}`);
  return keys[0]!;
}

function body(node: PgNode): PgNode {
  return node[tag(node)];
}

function strVal(node: PgNode): string {
  return body(node).sval ?? "";
}

function convertSelect(sel: PgNode): Query {
  if (sel.op && sel.op !== "SETOP_NONE") {
    throw new UnsupportedSqlError(
      "set operations (UNION/INTERSECT/EXCEPT) are not supported"
    );
  }
  if (sel.withClause) inlineCtes(sel);
  if (sel.intoClause)
    throw new UnsupportedSqlError("SELECT INTO is not supported");

  const fromClause: PgNode[] = sel.fromClause ?? [];
  if (fromClause.length === 0) {
    throw new UnsupportedSqlError(
      "queries must select FROM at least one table"
    );
  }
  let from = convertFromItem(fromClause[0]!);
  for (let i = 1; i < fromClause.length; i++) {
    from = {
      kind: "join",
      joinType: "inner",
      left: from,
      right: convertFromItem(fromClause[i]!),
      on: TRUE_EXPR
    };
  }

  const select: SelectItem[] = (sel.targetList ?? []).map(convertTarget);

  const distinct = sel.distinctClause !== undefined;
  if (distinct) {
    const items = sel.distinctClause as PgNode[];
    const hasOn = items.some(
      e => e && typeof e === "object" && Object.keys(e).length > 0
    );
    if (hasOn) throw new UnsupportedSqlError("DISTINCT ON is not supported");
  }

  const groupBy: Expr[] = (sel.groupClause ?? []).map((g: PgNode) =>
    convertExpr(g)
  );

  const orderBy: OrderItem[] = (sel.sortClause ?? []).map(convertSortBy);

  if (sel.limitOption === "LIMIT_OPTION_WITH_TIES")
    throw new UnsupportedSqlError("FETCH ... WITH TIES is not supported");

  const query: Query = {
    from,
    where: sel.whereClause ? convertExpr(sel.whereClause) : undefined,
    groupBy,
    having: sel.havingClause ? convertExpr(sel.havingClause) : undefined,
    select,
    distinct,
    orderBy,
    limit: sel.limitCount ? intConst(sel.limitCount) : undefined,
    offset: sel.limitOffset ? intConst(sel.limitOffset) : undefined
  };
  return query;
}

function inlineCtes(sel: PgNode): void {
  const wc = sel.withClause;
  const ctes: PgNode[] = wc.ctes ?? [];
  delete sel.withClause;
  if (wc.recursive) {
    throw new UnsupportedSqlError("WITH RECURSIVE is not supported");
  }
  for (let i = 0; i < ctes.length; i++) {
    const cte = ctes[i]!.CommonTableExpr;
    if (!cte?.ctequery?.SelectStmt) {
      throw new UnsupportedSqlError("only SELECT CTEs are supported");
    }
    if (cte.aliascolnames) {
      throw new UnsupportedSqlError(
        "CTE column aliases are not supported; alias columns in the CTE body"
      );
    }
    const refs = replaceCteRefs(
      [...ctes.slice(i + 1), sel],
      cte.ctename,
      cte.ctequery
    );
    if (refs > 1) {
      throw new UnsupportedSqlError(
        `CTE "${cte.ctename}" is referenced ${refs} times; ` +
          "only single-use CTEs are supported"
      );
    }
  }
}

function replaceCteRefs(root: unknown, name: string, body: PgNode): number {
  let count = 0;
  const visit = (container: any, key: string | number, value: any): void => {
    if (value === null || typeof value !== "object") return;
    const rv = value.RangeVar;
    if (rv && rv.relname === name && rv.schemaname === undefined) {
      count++;
      container[key] = {
        RangeSubselect: {
          subquery: body,
          alias: rv.alias ?? { aliasname: name }
        }
      };
      return;
    }
    const shadows = value.SelectStmt?.withClause?.ctes?.some(
      (c: PgNode) => c.CommonTableExpr?.ctename === name
    );
    if (shadows) return;
    walk(value);
  };
  const walk = (node: any): void => {
    if (Array.isArray(node)) node.forEach((v, i) => visit(node, i, v));
    else for (const k of Object.keys(node)) visit(node, k, node[k]);
  };
  walk(root);
  return count;
}

function convertFromItem(node: PgNode): FromItem {
  const t = tag(node);
  if (t === "RangeVar") {
    const rv = node.RangeVar;
    const alias = rv.alias?.aliasname ?? rv.relname;
    return { kind: "table", name: rv.relname, schema: rv.schemaname, alias };
  }
  if (t === "JoinExpr") {
    const je = node.JoinExpr;
    const joinType = mapJoinType(je.jointype);
    const left = convertFromItem(je.larg);
    const right = convertFromItem(je.rarg);
    const on = je.quals ? convertExpr(je.quals) : TRUE_EXPR;
    if (je.usingClause || je.isNatural) {
      throw new UnsupportedSqlError(
        "USING / NATURAL joins are not supported (use ON)"
      );
    }
    return { kind: "join", joinType, left, right, on };
  }
  if (t === "RangeSubselect") {
    const rs = node.RangeSubselect;
    const alias = rs.alias?.aliasname;
    if (!alias) {
      throw new UnsupportedSqlError("a subquery in FROM must be aliased");
    }
    if (!rs.subquery?.SelectStmt) {
      throw new UnsupportedSqlError("malformed subquery in FROM");
    }
    return {
      kind: "subquery",
      query: convertSelect(rs.subquery.SelectStmt),
      alias,
      lateral: Boolean(rs.lateral)
    };
  }
  throw new UnsupportedSqlError(`unsupported FROM item: ${t}`);
}

function mapJoinType(jt: string): "inner" | "left" {
  switch (jt) {
    case "JOIN_INNER":
      return "inner";
    case "JOIN_LEFT":
      return "left";
    case "JOIN_RIGHT":
      throw new UnsupportedSqlError(
        "RIGHT JOIN not supported (rewrite as LEFT JOIN)"
      );
    case "JOIN_FULL":
      throw new UnsupportedSqlError("FULL OUTER JOIN not supported");
    default:
      throw new UnsupportedSqlError(`unsupported join type ${jt}`);
  }
}

function convertTarget(node: PgNode): SelectItem {
  const rt = node.ResTarget;
  if (!rt) throw new SqlParseError("expected ResTarget in target list");
  const expr = convertExpr(rt.val);
  const alias = rt.name ?? defaultAlias(expr);
  return { expr, alias };
}

function defaultAlias(expr: Expr): string {
  switch (expr.kind) {
    case "column":
      return expr.name;
    case "func":
      return expr.name;
    case "jsonBuildObject":
      return "json_build_object";
    case "jsonAgg":
      return "json_agg";
    case "aggregate":
      return expr.func;
    case "coalesce":
      return "coalesce";
    default:
      return "expr";
  }
}

function convertSortBy(node: PgNode): OrderItem {
  const sb = node.SortBy;
  const desc = sb.sortby_dir === "SORTBY_DESC";
  const nullsFirst =
    sb.sortby_nulls === "SORTBY_NULLS_FIRST" ||
    (sb.sortby_nulls !== "SORTBY_NULLS_LAST" && desc);
  return { expr: convertExpr(sb.node), desc, nullsFirst };
}

function convertExpr(node: PgNode): Expr {
  const t = tag(node);
  switch (t) {
    case "ColumnRef":
      return convertColumnRef(node.ColumnRef);
    case "A_Const":
      return constLiteral(node.A_Const);
    case "ParamRef":
      return { kind: "param", index: node.ParamRef.number };
    case "A_Expr":
      return convertAExpr(node.A_Expr);
    case "BoolExpr":
      return convertBoolExpr(node.BoolExpr);
    case "NullTest":
      return {
        kind: "isNull",
        operand: convertExpr(node.NullTest.arg),
        negated: node.NullTest.nulltesttype === "IS_NOT_NULL"
      };
    case "CoalesceExpr":
      return {
        kind: "coalesce",
        args: (node.CoalesceExpr.args ?? []).map(convertExpr)
      };
    case "FuncCall":
      return convertFuncCall(node.FuncCall);
    case "TypeCast":
      return convertTypeCast(node.TypeCast);
    case "SubLink":
      return convertSubLink(node.SubLink);
    case "BooleanTest":
      return convertBooleanTest(node.BooleanTest);
    default:
      throw new UnsupportedSqlError(`unsupported expression node: ${t}`);
  }
}

function convertBooleanTest(bt: PgNode): Expr {
  const operand = convertExpr(bt.arg);
  const boolLit = (value: boolean): Expr => ({
    kind: "literal",
    value,
    ptype: "bool"
  });
  const coalesceTo = (fallback: boolean): Expr => ({
    kind: "coalesce",
    args: [operand, boolLit(fallback)]
  });
  switch (bt.booltesttype) {
    case "IS_TRUE":
      return coalesceTo(false);
    case "IS_NOT_TRUE":
      return { kind: "not", operand: coalesceTo(false) };
    case "IS_FALSE":
      return { kind: "not", operand: coalesceTo(true) };
    case "IS_NOT_FALSE":
      return coalesceTo(true);
    case "IS_UNKNOWN":
      return { kind: "isNull", operand, negated: false };
    case "IS_NOT_UNKNOWN":
      return { kind: "isNull", operand, negated: true };
    default:
      throw new UnsupportedSqlError(
        `unsupported boolean test: ${String(bt.booltesttype)}`
      );
  }
}

function convertColumnRef(cr: PgNode): Expr {
  const fields = cr.fields as PgNode[];
  if (tag(fields[fields.length - 1]!) === "A_Star") {
    const table =
      fields.length > 1 ? strVal(fields[fields.length - 2]!) : undefined;
    return { kind: "star", table };
  }
  const names = fields.map(strVal);
  if (names.length === 1) return { kind: "column", name: names[0]! };
  if (names.length === 2)
    return { kind: "column", table: names[0], name: names[1]! };
  return {
    kind: "column",
    table: names[names.length - 2],
    name: names[names.length - 1]!
  };
}

function constValue(c: PgNode): Scalar {
  if (c.isnull) return null;
  if (c.ival !== undefined) return c.ival.ival ?? 0;
  if (c.fval !== undefined) {
    const text = c.fval.fval ?? "0";
    const canon = canonNumeric(text);
    if (canon === null)
      throw new UnsupportedSqlError(
        `numeric literal ${text} overflows numeric format`
      );
    return canon;
  }
  if (c.sval !== undefined) return c.sval.sval ?? "";
  if (c.boolval !== undefined) return Boolean(c.boolval.boolval);
  if (c.bsval !== undefined)
    throw new UnsupportedSqlError("bit string literals are not supported");
  return null;
}

function constLiteral(c: PgNode): Expr {
  const value = constValue(c);
  if (c.isnull) return { kind: "literal", value };
  if (c.ival !== undefined) return { kind: "literal", value, ptype: "int" };
  if (c.fval !== undefined) {
    const raw = c.fval.fval ?? "";
    const int8 =
      /^(\d(?:_?\d)*|0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/.test(raw) &&
      typeof value === "string" &&
      BigInt(value) <= 2n ** 63n - 1n;
    return { kind: "literal", value, ptype: int8 ? "int8" : "numeric" };
  }
  if (c.sval !== undefined)
    return { kind: "literal", value, ptype: "text", quoted: true };
  if (c.boolval !== undefined) return { kind: "literal", value, ptype: "bool" };
  return { kind: "literal", value };
}

function intConst(node: PgNode): Limit | undefined {
  if (tag(node) === "A_Const") {
    if (node.A_Const.isnull) return undefined;
    const v = constValue(node.A_Const);
    if (typeof v === "number") return v;
  }
  if (tag(node) === "ParamRef") return { param: node.ParamRef.number };
  throw new UnsupportedSqlError(
    "LIMIT/OFFSET must be an integer literal or a $n parameter"
  );
}

const OP_MAP: Record<string, BinaryOp> = {
  "=": "=",
  "<>": "<>",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%"
};

function convertAExpr(e: PgNode): Expr {
  const opName = (e.name ?? []).map(strVal).join("");
  switch (e.kind) {
    case "AEXPR_OP": {
      if (e.lexpr === undefined || e.lexpr === null) {
        if (opName === "-")
          return { kind: "neg", operand: convertExpr(e.rexpr) };
        if (opName === "+") return convertExpr(e.rexpr);
        throw new UnsupportedSqlError(`unsupported unary operator ${opName}`);
      }
      const mapped = OP_MAP[opName];
      if (!mapped)
        throw new UnsupportedSqlError(`unsupported operator ${opName}`);
      return {
        kind: "binary",
        op: mapped,
        left: convertExpr(e.lexpr),
        right: convertExpr(e.rexpr)
      };
    }
    case "AEXPR_LIKE":
    case "AEXPR_ILIKE": {
      const op = e.kind === "AEXPR_ILIKE" ? "ilike" : "like";
      const expr: Expr = {
        kind: "binary",
        op,
        left: convertExpr(e.lexpr),
        right: convertExpr(e.rexpr)
      };
      return opName.startsWith("!") ? { kind: "not", operand: expr } : expr;
    }
    case "AEXPR_IN": {
      const list = listItems(e.rexpr).map(convertExpr);
      return {
        kind: "in",
        operand: convertExpr(e.lexpr),
        list,
        negated: opName === "<>"
      };
    }
    case "AEXPR_OP_ANY":
    case "AEXPR_OP_ALL":
      return convertAnyAll(e, opName);
    case "AEXPR_BETWEEN":
    case "AEXPR_NOT_BETWEEN":
    case "AEXPR_BETWEEN_SYM":
    case "AEXPR_NOT_BETWEEN_SYM":
      return convertBetween(e);
    case "AEXPR_DISTINCT":
    case "AEXPR_NOT_DISTINCT":
      return convertDistinct(e);
    default:
      throw new UnsupportedSqlError(`unsupported A_Expr kind ${e.kind}`);
  }
}

function convertBetween(e: PgNode): Expr {
  const bounds = listItems(e.rexpr).map(convertExpr);
  if (bounds.length !== 2)
    throw new UnsupportedSqlError("BETWEEN requires two bounds");
  const operand = convertExpr(e.lexpr);
  const within = (lo: Expr, hi: Expr): Expr => ({
    kind: "and",
    items: [
      { kind: "binary", op: ">=", left: operand, right: lo },
      { kind: "binary", op: "<=", left: operand, right: hi }
    ]
  });
  const sym =
    e.kind === "AEXPR_BETWEEN_SYM" || e.kind === "AEXPR_NOT_BETWEEN_SYM";
  const inRange: Expr = sym
    ? {
        kind: "or",
        items: [within(bounds[0]!, bounds[1]!), within(bounds[1]!, bounds[0]!)]
      }
    : within(bounds[0]!, bounds[1]!);
  const negated =
    e.kind === "AEXPR_NOT_BETWEEN" || e.kind === "AEXPR_NOT_BETWEEN_SYM";
  return negated ? { kind: "not", operand: inRange } : inRange;
}

function convertDistinct(e: PgNode): Expr {
  const left = convertExpr(e.lexpr);
  const right = convertExpr(e.rexpr);
  const sameNullity: Expr = {
    kind: "binary",
    op: "=",
    left: { kind: "isNull", operand: left, negated: false },
    right: { kind: "isNull", operand: right, negated: false }
  };
  const equalIfBothPresent: Expr = {
    kind: "coalesce",
    args: [
      { kind: "binary", op: "=", left, right },
      { kind: "literal", value: true, ptype: "bool" }
    ]
  };
  const notDistinct: Expr = {
    kind: "and",
    items: [sameNullity, equalIfBothPresent]
  };
  return e.kind === "AEXPR_NOT_DISTINCT"
    ? notDistinct
    : { kind: "not", operand: notDistinct };
}

function convertAnyAll(e: PgNode, opName: string): Expr {
  const isAny = e.kind === "AEXPR_OP_ANY";
  const eq = opName === "=";
  const ne = opName === "<>" || opName === "!=";
  if (!((isAny && eq) || (!isAny && ne))) {
    throw new UnsupportedSqlError(
      "only `= ANY (...)` and `<> ALL (...)` are supported"
    );
  }
  if (e.rexpr && tag(e.rexpr) === "ParamRef") {
    return {
      kind: "anyParam",
      operand: convertExpr(e.lexpr),
      param: e.rexpr.ParamRef.number,
      negated: !isAny
    };
  }
  if (!e.rexpr || tag(e.rexpr) !== "A_ArrayExpr") {
    throw new UnsupportedSqlError(
      "ANY/ALL requires an ARRAY[...] literal or a $n array parameter"
    );
  }
  const list = (e.rexpr.A_ArrayExpr.elements ?? []).map(convertExpr);
  return {
    kind: "in",
    operand: convertExpr(e.lexpr),
    list,
    negated: !isAny
  };
}

function listItems(node: PgNode): PgNode[] {
  if (Array.isArray(node)) return node;
  if (node && tag(node) === "List") return node.List.items ?? [];
  return [node];
}

function convertBoolExpr(b: PgNode): Expr {
  const args = (b.args ?? []).map(convertExpr);
  switch (b.boolop) {
    case "AND_EXPR":
      return { kind: "and", items: args };
    case "OR_EXPR":
      return { kind: "or", items: args };
    case "NOT_EXPR": {
      const raw = b.args?.[0];
      if (
        raw &&
        tag(raw) === "SubLink" &&
        raw.SubLink.subLinkType === "ANY_SUBLINK"
      ) {
        throw new UnsupportedSqlError(
          "NOT IN (subquery) has three-valued NULL semantics Walter does not " +
            "reproduce; rewrite as NOT EXISTS with explicit IS NOT NULL guards"
        );
      }
      const operand = args[0]!;
      if (operand.kind === "exists")
        return { ...operand, negated: !operand.negated };
      return { kind: "not", operand };
    }
    default:
      throw new UnsupportedSqlError(`unsupported boolean op ${b.boolop}`);
  }
}

function convertFuncCall(f: PgNode): Expr {
  const name = (f.funcname ?? []).map(strVal).join(".").toLowerCase();
  const simpleName = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : name;
  const args: PgNode[] = f.args ?? [];
  const filter = f.agg_filter ? convertExpr(f.agg_filter) : undefined;
  if (f.over)
    throw new UnsupportedSqlError("window functions are not supported");
  if (f.agg_within_group)
    throw new UnsupportedSqlError("WITHIN GROUP is not supported");

  if (
    simpleName === "json_build_object" ||
    simpleName === "jsonb_build_object"
  ) {
    return convertJsonBuildObject(args);
  }
  if (
    simpleName === "json_agg" ||
    simpleName === "jsonb_agg" ||
    simpleName === "array_agg"
  ) {
    if (args.length !== 1)
      throw new UnsupportedSqlError(`${simpleName} expects one argument`);
    if (f.agg_distinct) {
      throw new UnsupportedSqlError(
        `${simpleName}(DISTINCT ...) is not supported`
      );
    }
    const arg = convertExpr(args[0]!);
    if (simpleName === "array_agg" && arg.kind !== "jsonBuildObject") {
      throw new UnsupportedSqlError(
        "array_agg is supported only over json_build_object(...) (a collection spelling); use json_agg for scalar aggregation"
      );
    }
    return {
      kind: "jsonAgg",
      arg,
      orderBy: (f.agg_order ?? []).map(convertSortBy),
      filter
    };
  }
  if (AGG_FUNCS.includes(simpleName as AggFunc)) {
    const func = simpleName as AggFunc;
    if (func === "count" && f.agg_star) {
      return { kind: "aggregate", func: "count", distinct: false, filter };
    }
    if (args.length !== 1) {
      throw new UnsupportedSqlError(`${func}() expects exactly one argument`);
    }
    const distinct =
      func !== "min" && func !== "max" && Boolean(f.agg_distinct);
    return {
      kind: "aggregate",
      func,
      arg: convertExpr(args[0]!),
      distinct,
      filter
    };
  }

  if (WHOLE_ROW_FUNCS.includes(simpleName as WholeRowFunc)) {
    if (args.length !== 1)
      throw new UnsupportedSqlError(`${simpleName} expects one argument`);
    return {
      kind: "wholeRow",
      func: simpleName as WholeRowFunc,
      arg: convertExpr(args[0]!)
    };
  }
  if (!SCALAR_FUNCS.includes(simpleName as ScalarFunc)) {
    throw new UnsupportedSqlError(`unsupported function ${simpleName}()`);
  }
  return {
    kind: "func",
    name: simpleName as ScalarFunc,
    args: args.map(convertExpr)
  };
}

function convertJsonBuildObject(args: PgNode[]): Expr {
  if (args.length % 2 !== 0) {
    throw new UnsupportedSqlError(
      "json_build_object needs an even number of arguments"
    );
  }
  const pairs: { key: string; value: Expr }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const keyExpr = convertExpr(args[i]!);
    if (keyExpr.kind !== "literal" || typeof keyExpr.value !== "string") {
      throw new UnsupportedSqlError(
        "json_build_object keys must be string literals"
      );
    }
    pairs.push({ key: keyExpr.value, value: convertExpr(args[i + 1]!) });
  }
  return { kind: "jsonBuildObject", pairs };
}

function convertTypeCast(tc: PgNode): Expr {
  const operand = convertExpr(tc.arg);
  const typeName = (tc.typeName?.names ?? []).map(strVal).pop() ?? "";
  const to = castTargetOf(typeName);
  if (to === undefined) {
    throw new UnsupportedSqlError(`unsupported cast ::${typeName}`);
  }
  if ((tc.typeName?.typmods ?? []).length > 0) {
    throw new UnsupportedSqlError(
      `unsupported cast ::${typeName} with a type modifier`
    );
  }
  if ((tc.typeName?.arrayBounds ?? []).length > 0) {
    throw new UnsupportedSqlError(`unsupported array cast ::${typeName}[]`);
  }
  if (
    operand.kind === "literal" &&
    to === "bool" &&
    typeof operand.value === "string"
  ) {
    const b = parseBoolText(operand.value);
    if (b === undefined) {
      throw new UnsupportedSqlError(
        `invalid bool literal ${JSON.stringify(operand.value)}`
      );
    }
    return { kind: "literal", value: b, ptype: "bool" };
  }
  return { kind: "cast", operand, to };
}

function convertSubLink(sl: PgNode): Expr {
  const sub = sl.subselect?.SelectStmt;
  if (sl.subLinkType === "EXISTS_SUBLINK") {
    if (!sub) throw new UnsupportedSqlError("malformed EXISTS subquery");
    return { kind: "exists", subquery: convertSelect(sub), negated: false };
  }
  if (sl.subLinkType === "ANY_SUBLINK") return convertInSubquery(sl);
  if (sl.subLinkType === "EXPR_SUBLINK") {
    if (!sub) throw new UnsupportedSqlError("malformed scalar subquery");
    return { kind: "scalarSubquery", subquery: convertSelect(sub) };
  }
  throw new UnsupportedSqlError(
    "only EXISTS, IN (subquery) and scalar subqueries are supported"
  );
}

function convertInSubquery(sl: PgNode): Expr {
  const sub = sl.subselect?.SelectStmt;
  if (!sub) throw new UnsupportedSqlError("malformed IN subquery");
  const op = (sl.operName ?? []).map(strVal).join("");
  if (op !== "" && op !== "=") {
    throw new UnsupportedSqlError(
      `only = ANY (subquery) is supported, not ${op} ANY`
    );
  }
  const query = convertSelect(sub);
  if (query.select.length !== 1) {
    throw new UnsupportedSqlError(
      "IN (subquery) must select exactly one column"
    );
  }
  let y = query.select[0]!.expr;
  if (y.kind === "column" && !y.table && query.from.kind === "table") {
    y = { ...y, table: query.from.alias };
  }
  const x = convertExpr(sl.testexpr);
  if (hasBareColumn(x)) {
    throw new UnsupportedSqlError(
      "qualify column references on the left of IN (subquery); the subquery's " +
        "tables shadow outer names"
    );
  }
  const eq: Expr = { kind: "binary", op: "=", left: y, right: x };
  return {
    kind: "exists",
    subquery: {
      ...query,
      where: query.where ? { kind: "and", items: [query.where, eq] } : eq
    },
    negated: false
  };
}

function hasBareColumn(e: Expr): boolean {
  let found = false;
  forEachExpr(e, n => {
    if (n.kind === "column" && n.table === undefined) found = true;
  });
  return found;
}
