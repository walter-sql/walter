import type {
  CollectionSpec,
  Expr,
  FromItem,
  Limit,
  OrderItem,
  Query,
  SelectItem,
  ShapeQuery
} from "../parser/ir";
import {
  UnsupportedSqlError,
  forEachChild,
  forEachExpr,
  ownExprRoots,
  visitQueries
} from "../parser/ir";
import { canonicalize } from "../ivm/zset";
import { comparisonClass, threadQueryTypes } from "./types";
import { PlanScope } from "./scope";
import type { SchemaCatalog } from "../parser/catalog";
import { SORT_OF, sortClassOf, type SortClass } from "../parser/pgtypes";
import type { Params, SortKeySpec } from "../parser/eval";
import { Layout } from "./layout";
import { compileExpr, compilePredicate, type CompiledExpr } from "./compile";
import { Dataflow } from "../ivm/graph";
import { DataflowNode, FilterNode, ProjectNode, SourceNode } from "../ivm/node";
import { JoinNode } from "../ivm/join";
import {
  AggregateNode,
  DistinctNode,
  type CompiledAggregateSpec
} from "../ivm/aggregate";
import { TopKNode } from "../ivm/topk";
import {
  pageSizeFor,
  type JoinPair,
  type PartnerTrigger,
  type WindowSortKey,
  type WindowSpec
} from "../lazy/window";
import {
  analyzeLazyTree,
  type AnchorPull,
  type LazyPlan
} from "../lazy/analyze";
import { ExistsNode } from "../ivm/exists";
import { matchKey } from "../ivm/tuple";
import {
  aliasesOf,
  andAll,
  collectAggregates,
  collectUngroupedColumns,
  correlationCoversChildKey,
  equiColumns,
  exprEquals,
  hasAggregate,
  nullableAliases,
  orientBySides,
  referencedAliases,
  referencesOnly,
  rewriteExpr,
  splitAnd,
  splitJoinCondition,
  type Column,
  type RewriteRule
} from "./exprutil";

const aliasOf = (e: Column): string => e.table!;

export interface LevelOrder extends SortKeySpec {
  field: string;
}

function sortClass(e: Expr): SortClass | undefined {
  return e.ptype === undefined ? undefined : SORT_OF[e.ptype];
}

function orderClass(e: Expr): SortClass {
  if (e.ptype === undefined) {
    throw new UnsupportedSqlError(
      "cannot order by a value whose type Walter does not support " +
        "(unsupported column type or untypeable expression); cast it explicitly"
    );
  }
  return SORT_OF[e.ptype];
}

function validateParams(node: ShapeQuery, params: Params): void {
  const seen = new Set<number>();
  const collect = (n: ShapeQuery): void => {
    visitQueries(n.query, q => {
      for (const r of ownExprRoots(q))
        forEachExpr(r, e => {
          if (e.kind === "param") seen.add(e.index);
          else if (e.kind === "anyParam") seen.add(e.param);
        });
      for (const v of [q.limit, q.offset]) {
        if (typeof v === "object") seen.add(v.param);
      }
    });
    for (const c of n.collections) collect(c.node);
  };
  collect(node);
  const max = Math.max(0, ...seen);
  if (params.length < max) {
    throw new UnsupportedSqlError(
      `query references $${max} but received ${params.length} parameter(s)`
    );
  }
  for (let i = 1; i <= params.length; i++) {
    if (!seen.has(i)) {
      throw new UnsupportedSqlError(`parameter $${i} is never referenced`);
    }
  }
}

export function foldArrayParams(node: ShapeQuery, params: Params): void {
  const foldExpr = (e: Expr): void => {
    if (e.kind !== "anyParam") return;
    const v = params[e.param - 1] ?? null;
    let list: Expr[];
    if (v === null) list = [{ kind: "literal", value: null }];
    else if (!Array.isArray(v)) {
      throw new UnsupportedSqlError(
        `ANY/ALL parameter $${e.param} must be an array`
      );
    } else list = v.map(el => elementLiteral(el, e.param));
    Object.assign(e, { kind: "in", list });
    delete (e as { param?: number }).param;
  };
  visitQueries(node.query, q => {
    for (const r of ownExprRoots(q)) forEachExpr(r, foldExpr);
  });
  for (const c of node.collections) foldArrayParams(c.node, params);
}

function elementLiteral(el: unknown, param: number): Expr {
  const v = canonicalize(el);
  if (v !== null && typeof v === "object") {
    throw new UnsupportedSqlError(
      `ANY/ALL array parameter $${param} must contain only scalar elements`
    );
  }
  if (v === null) return { kind: "literal", value: null };
  return { kind: "literal", value: String(v), ptype: "text", quoted: true };
}

function foldLimit(
  v: Limit | undefined,
  params: Params,
  what: "LIMIT" | "OFFSET"
): number | undefined {
  if (v === undefined || typeof v === "number") return v;
  const p = params[v.param - 1];
  if (p === null || p === undefined) return undefined;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 0) {
    throw new UnsupportedSqlError(
      `${what} $${v.param} must be a non-negative integer`
    );
  }
  return p;
}

export interface CompiledWindow {
  spec: WindowSpec;
  topk: TopKNode;
}

export interface CorrelationSource extends AnchorPull {
  aliases: string[];
}

export interface LevelPlan {
  dataflow: Dataflow;
  tables: string[];
  keyColumns: string[];
  wireColumns: string[];
  order: LevelOrder[];
  lazySourcing: () => LazyPlan;
  correlationSource: CorrelationSource | undefined;
  window: CompiledWindow | undefined;
  collections: CompiledCollection[];
}

export interface CompiledCollection {
  field: string;
  parentKey: string[];
  single: boolean;
  level: LevelPlan;
}

export interface ShapeTreePlan {
  root: LevelPlan;
  tables: string[];
}

interface PlanCtx {
  params: Params;
  scope: PlanScope;
  sources: SourceNode[];
}

export function planShape(
  shape: ShapeQuery,
  params: Params,
  catalog: SchemaCatalog
): ShapeTreePlan {
  validateParams(shape, params);
  shape = structuredClone(shape);
  foldArrayParams(shape, params);
  const root = planLevel(shape, params, catalog, []);
  const tables = new Set<string>();
  collectLevelTables(root, tables);
  return { root, tables: [...tables] };
}

function collectLevelTables(level: LevelPlan, out: Set<string>): void {
  for (const t of level.tables) out.add(t);
  for (const c of level.collections) collectLevelTables(c.level, out);
}

function planLevel(
  node: ShapeQuery,
  params: Params,
  catalog: SchemaCatalog,
  correlationAliases: string[]
): LevelPlan {
  const { query } = node;
  const scope = PlanScope.forQuery(query, catalog);
  threadQueryTypes(query, scope.classOf);
  const limit = foldLimit(query.limit, params, "LIMIT");
  const offset = foldLimit(query.offset, params, "OFFSET") ?? 0;

  const correlationSource =
    correlationAliases.length > 0
      ? resolveCorrelationSource(query, correlationAliases, scope)
      : undefined;

  const discharged = dischargedAliases(query, scope);
  const window = planLevelWindow(
    query,
    limit,
    offset,
    scope,
    discharged,
    correlationSource
  );

  const anchor: AnchorPull | undefined =
    correlationSource ??
    (window && { table: window.anchorTable, columns: [], classes: [] });
  let cachedSourcing: LazyPlan | undefined;
  const lazySourcing = (): LazyPlan =>
    (cachedSourcing ??= analyzeLazyTree(query, scope, params, anchor));

  const built = buildLevelDataflow(
    query,
    limit,
    offset,
    params,
    scope,
    correlationSource,
    discharged,
    window
  );
  const collections = node.collections.map(spec =>
    planCollection(spec, params, catalog)
  );
  return { ...built, lazySourcing, correlationSource, collections };
}

function planCollection(
  spec: CollectionSpec,
  params: Params,
  catalog: SchemaCatalog
): CompiledCollection {
  const level = planLevel(spec.node, params, catalog, spec.childKey);
  const source = level.correlationSource!;

  const childKeys = catalog.keysOf(source.table);
  const limit = foldLimit(spec.node.query.limit, params, "LIMIT");
  const single =
    spec.object &&
    (correlationCoversChildKey(source.columns, childKeys) ||
      (limit !== undefined && limit <= 1));
  if (spec.object && !single) {
    throw new UnsupportedSqlError(
      `to-one "${spec.field}" is not provably ≤1 per parent ` +
        "(needs unique-key correlation or LIMIT 1)"
    );
  }

  return { field: spec.field, parentKey: spec.parentKey, single, level };
}

function resolveCorrelationSource(
  query: Query,
  childKey: string[],
  scope: PlanScope
): CorrelationSource {
  let table: string | undefined;
  const columns: string[] = [];
  const classes: (SortClass | undefined)[] = [];
  for (const alias of childKey) {
    const item = query.select.find(s => s.alias === alias);
    if (!item || item.expr.kind !== "column") {
      throw new UnsupportedSqlError(
        `collection correlation column "${alias}" must be a plain child column`
      );
    }
    const t = scope.aliasToTable.get(aliasOf(item.expr));
    if (t === undefined) {
      throw new UnsupportedSqlError(
        `cannot resolve correlation column "${alias}" to a table`
      );
    }
    if (table === undefined) table = t;
    else if (table !== t) {
      throw new UnsupportedSqlError(
        "collection correlation columns must come from one table"
      );
    }
    columns.push(item.expr.name);
    classes.push(sortClass(item.expr));
  }
  if (table === undefined) {
    throw new UnsupportedSqlError("collection has no correlation columns");
  }
  return { aliases: childKey, table, columns, classes };
}

type BuiltLevel = Omit<
  LevelPlan,
  "lazySourcing" | "correlationSource" | "collections"
>;

function buildLevelDataflow(
  query: Query,
  limit: number | undefined,
  offset: number,
  params: Params,
  scope: PlanScope,
  correlationSource: CorrelationSource | undefined,
  discharged: ReadonlySet<string>,
  windowSpec: WindowSpec | undefined
): BuiltLevel {
  const ctx: PlanCtx = { params, scope, sources: [] };
  const correlationAliases = correlationSource?.aliases ?? [];

  let { node, layout } = buildFrom(query.from, ctx);

  const conjuncts = splitAnd(query.where);
  const normal: Expr[] = [];
  const existsConjuncts: Extract<Expr, { kind: "exists" }>[] = [];
  for (const c of conjuncts) {
    if (c.kind === "exists") existsConjuncts.push(c);
    else normal.push(c);
  }
  const wherePred = andAll(normal);
  if (wherePred) {
    node = new FilterNode(node, compilePredicate(wherePred, layout, params));
  }
  for (const ex of existsConjuncts) {
    node = buildExists(node, layout, ex, ctx);
  }

  const isAgg = query.groupBy.length > 0 || hasAggregateExpr(query);

  const hasLimit = limit !== undefined || offset > 0;
  const pkOrder: OrderItem[] = [];
  if (windowSpec) {
    const w = windowSpec;
    for (let i = w.order.length - w.pkKeys; i < w.order.length; i++) {
      const k = w.order[i]!;
      pkOrder.push({
        expr: {
          kind: "column",
          table: w.anchorAlias,
          name: k.column,
          ptype: scope.classOf(w.anchorAlias, k.column)
        },
        desc: false,
        nullsFirst: false
      });
    }
  }
  const sortBy: OrderItem[] = [...query.orderBy, ...pkOrder];

  let keyColumns: string[];
  let projectItems: SelectItem[];
  let sortExprs: Expr[];

  if (isAgg) {
    const built = buildAggregate(node, layout, query, sortBy, ctx);
    node = built.node;
    layout = built.layout;
    keyColumns = built.keyColumns;
    projectItems = built.projectItems;
    sortExprs = built.sortExprs;
  } else {
    if (query.having)
      throw new UnsupportedSqlError("HAVING requires GROUP BY/aggregates");
    projectItems = query.select;
    sortExprs = sortBy.map(o => o.expr);
    keyColumns = deriveKeyColumns(
      query.select,
      scope,
      correlationAliases,
      discharged
    );
    if (keyColumns.length > 0)
      keyColumns = [
        ...correlationAliases.filter(a => !keyColumns.includes(a)),
        ...keyColumns
      ];
  }

  const projectAliases = projectItems.map(i => i.alias);
  const projectExprs: CompiledExpr[] = projectItems.map(i =>
    compileExpr(i.expr, layout, params)
  );
  const sortFields = sortBy.map((_, i) => `__sort_${i}`);
  for (const e of sortExprs) projectExprs.push(compileExpr(e, layout, params));
  const outputColumns = [...projectAliases, ...sortFields];
  node = new ProjectNode(node, projectExprs);

  if (query.distinct) {
    for (const o of sortBy) {
      const inSelect = query.select.some(s => exprEquals(s.expr, o.expr));
      if (!inSelect) {
        throw new UnsupportedSqlError(
          "for SELECT DISTINCT, ORDER BY expressions must appear in select list"
        );
      }
    }
    node = new DistinctNode(
      node,
      [...projectItems.map(i => i.expr), ...sortExprs].map(sortClass)
    );
  }

  const sortStart = projectAliases.length;
  const order: LevelOrder[] = sortBy.map((o, i) => ({
    field: sortFields[i]!,
    desc: o.desc,
    nullsFirst: o.nullsFirst,
    cls: orderClass(o.expr)
  }));

  let window: CompiledWindow | undefined;
  if (hasLimit) {
    const groupSlots = correlationAliases.map(a => projectAliases.indexOf(a));
    const topk = new TopKNode(
      node,
      groupSlots,
      correlationSource?.classes ?? [],
      order,
      sortStart,
      limit,
      offset
    );
    node = topk;
    if (windowSpec) window = { spec: windowSpec, topk };
  }

  const wireColumns = projectAliases.filter(
    a => !correlationAliases.includes(a)
  );

  return {
    dataflow: new Dataflow(node, ctx.sources, outputColumns),
    tables: [...new Set(ctx.sources.map(s => s.table))],
    keyColumns,
    wireColumns,
    order,
    window
  };
}

function planLevelWindow(
  query: Query,
  limit: number | undefined,
  offset: number,
  scope: PlanScope,
  discharged: ReadonlySet<string>,
  correlationSource: CorrelationSource | undefined
): WindowSpec | undefined {
  if (limit === undefined || query.orderBy.length === 0) return undefined;
  if (query.distinct || query.having) return undefined;
  if (splitAnd(query.where).some(hasSubquery)) return undefined;

  const usage = collectAggUsage(query);
  const aggOnly = new Set<string>();
  const candidates: string[] = [];
  for (const alias of scope.aliasToTable.keys()) {
    if (discharged.has(alias)) continue;
    if (usage.inside.has(alias) && !usage.outside.has(alias)) {
      aggOnly.add(alias);
    } else {
      candidates.push(alias);
    }
  }

  let anchorAlias: string;
  if (correlationSource) {
    const ref = scope.tables.find(t => t.name === correlationSource.table);
    if (!ref) return undefined;
    anchorAlias = ref.alias;
    aggOnly.delete(anchorAlias);
    if (candidates.some(a => a !== anchorAlias)) return undefined;
  } else {
    if (candidates.length !== 1) return undefined;
    anchorAlias = candidates[0]!;
  }
  const anchorTable = scope.aliasToTable.get(anchorAlias)!;
  const nullable = nullableAliases(query.from);
  if (nullable.has(anchorAlias)) return undefined;

  const pkCols = scope.catalog.keyColumnsOf(anchorTable);
  if (pkCols.length === 0) return undefined;
  for (const c of pkCols) {
    if (sortClassOf(scope.typeNameOf(anchorAlias, c)) === undefined)
      return undefined;
  }

  const isAgg = query.groupBy.length > 0 || hasAggregateExpr(query);
  if (isAgg) {
    if (query.groupBy.length === 0) return undefined;
    for (const c of pkCols) {
      const grouped = query.groupBy.some(
        g => g.kind === "column" && g.name === c && g.table === anchorAlias
      );
      if (!grouped) return undefined;
    }
    for (const alias of aggOnly) {
      if (!prunableLeftLeaf(query.from, alias)) return undefined;
    }
  } else if (aggOnly.size > 0) {
    return undefined;
  }

  const order: WindowSortKey[] = [];
  for (const o of query.orderBy) {
    if (o.expr.kind !== "column") return undefined;
    const alias = aliasOf(o.expr);
    if (alias !== anchorAlias && !discharged.has(alias)) return undefined;
    const cls = sortClassOf(scope.typeNameOf(alias, o.expr.name));
    if (cls === undefined) return undefined;
    order.push({
      alias,
      column: o.expr.name,
      anchor: alias === anchorAlias,
      desc: o.desc,
      nullsFirst: o.nullsFirst,
      cls
    });
  }
  for (const c of pkCols) {
    order.push({
      alias: anchorAlias,
      column: c,
      anchor: true,
      desc: false,
      nullsFirst: false,
      cls: sortClassOf(scope.typeNameOf(anchorAlias, c))!
    });
  }

  const from = pruneFrom(query.from, aggOnly);
  if (!from || onHasSubquery(from)) return undefined;
  const where = andAll(splitAnd(query.where));

  const partnerTriggers: PartnerTrigger[] = [];
  for (const alias of aliasesOf(from)) {
    if (alias === anchorAlias) continue;
    const sortWhere = new Set<string>();
    if (where) collectAliasColumns(where, alias, sortWhere);
    for (const k of order) if (k.alias === alias) sortWhere.add(k.column);
    partnerTriggers.push({
      table: scope.aliasToTable.get(alias)!,
      inner: !nullable.has(alias),
      sortWhere: [...sortWhere],
      pairs: collectJoinPairs(from, alias)
    });
  }

  const windowSize = offset + limit;
  return {
    anchorTable,
    anchorAlias,
    order,
    pkKeys: pkCols.length,
    windowSize,
    pageSize: pageSizeFor(windowSize),
    fetch: { from, where },
    partnerTriggers
  };
}

function hasSubquery(e: Expr): boolean {
  let found = false;
  forEachExpr(e, n => {
    if (n.kind === "exists" || n.kind === "scalarSubquery") found = true;
  });
  return found;
}

function onHasSubquery(f: FromItem): boolean {
  return (
    f.kind === "join" &&
    (hasSubquery(f.on) || onHasSubquery(f.left) || onHasSubquery(f.right))
  );
}

function collectAggUsage(query: Query): {
  outside: Set<string>;
  inside: Set<string>;
} {
  const outside = new Set<string>();
  const inside = new Set<string>();
  const collect = (e: Expr, into: Set<string>): void =>
    forEachExpr(e, n => {
      if (n.kind === "column") into.add(aliasOf(n));
      else if (n.kind === "aggregate" || n.kind === "jsonAgg") {
        forEachChild(n, c => collect(c, inside));
        return false;
      }
    });
  for (const s of query.select) collect(s.expr, outside);
  for (const g of query.groupBy) collect(g, outside);
  for (const o of query.orderBy) collect(o.expr, outside);
  for (const c of splitAnd(query.where)) collect(c, outside);
  return { outside, inside };
}

function prunableLeftLeaf(from: FromItem, alias: string): boolean {
  if (from.kind !== "join") return false;
  if (from.right.kind === "table" && from.right.alias === alias) {
    return from.joinType === "left";
  }
  return (
    prunableLeftLeaf(from.left, alias) || prunableLeftLeaf(from.right, alias)
  );
}

function pruneFrom(
  from: FromItem,
  drop: ReadonlySet<string>
): FromItem | undefined {
  if (from.kind === "table") return drop.has(from.alias) ? undefined : from;
  if (from.kind === "subquery") return from;
  const left = pruneFrom(from.left, drop);
  const right = pruneFrom(from.right, drop);
  if (left && right) {
    return left === from.left && right === from.right
      ? from
      : { ...from, left, right };
  }
  return left ?? right;
}

function collectAliasColumns(
  expr: Expr,
  alias: string,
  out: Set<string>
): void {
  forEachExpr(expr, e => {
    if (e.kind === "column" && e.table === alias) out.add(e.name);
  });
}

function collectJoinPairs(from: FromItem, alias: string): JoinPair[] {
  const out: JoinPair[] = [];
  const walk = (f: FromItem): void => {
    if (f.kind !== "join") return;
    for (const c of splitAnd(f.on)) {
      const cols = equiColumns(c);
      if (!cols) continue;
      for (const [mine, other] of [
        [cols.left, cols.right],
        [cols.right, cols.left]
      ] as const) {
        if (aliasOf(mine) === alias && aliasOf(other) !== alias)
          out.push({
            partner: mine.name,
            alias: aliasOf(other),
            column: other.name
          });
      }
    }
    walk(f.left);
    walk(f.right);
  };
  walk(from);
  return out;
}

function sourceLayout(alias: string, table: string, scope: PlanScope): Layout {
  return Layout.forSource(alias, scope.catalog.columnsOf(table)!);
}

function buildFrom(
  from: FromItem,
  ctx: PlanCtx
): { node: DataflowNode; layout: Layout } {
  if (from.kind === "table") {
    const layout = sourceLayout(from.alias, from.name, ctx.scope);
    const src = new SourceNode(
      from.alias,
      from.name,
      layout.slots.map(s => s.name)
    );
    ctx.sources.push(src);
    return { node: src, layout };
  }
  if (from.kind === "subquery") {
    throw new UnsupportedSqlError(
      "internal: a FROM subquery survived lift (should have been lowered)"
    );
  }
  const left = buildFrom(from.left, ctx);
  const right = buildFrom(from.right, ctx);
  const merged = left.layout.concat(right.layout);
  const leftAliases = aliasesOf(from.left);
  const rightAliases = aliasesOf(from.right);
  const { equiKeys, residual } = splitJoinCondition(
    from.on,
    leftAliases,
    rightAliases
  );
  const classes = equiKeys.map(k => comparisonClass(k.left, k.right));
  const node = new JoinNode(
    left.node,
    right.node,
    matchKey(
      equiKeys.map(k => compileExpr(k.left, left.layout, ctx.params)),
      classes
    ),
    matchKey(
      equiKeys.map(k => compileExpr(k.right, right.layout, ctx.params)),
      classes
    ),
    residual ? compilePredicate(residual, merged, ctx.params) : undefined,
    from.joinType,
    right.layout.arity
  );
  return { node, layout: merged };
}

function buildExists(
  parent: DataflowNode,
  parentLayout: Layout,
  ex: Extract<Expr, { kind: "exists" }>,
  ctx: PlanCtx
): DataflowNode {
  const sub = ex.subquery;
  if (sub.from.kind !== "table") {
    throw new UnsupportedSqlError(
      "EXISTS subqueries must read from a single table"
    );
  }
  if (
    sub.groupBy.length > 0 ||
    hasAggregateExpr(sub) ||
    sub.limit !== undefined ||
    sub.offset !== undefined
  ) {
    throw new UnsupportedSqlError(
      "EXISTS subqueries cannot use GROUP BY / aggregates / LIMIT / OFFSET"
    );
  }
  const childAlias = sub.from.alias;
  const childAliases = new Set([childAlias]);
  const outerAliases = new Set(
    parentLayout.slots.map(s => s.alias).filter((a): a is string => !!a)
  );

  const subScope = new PlanScope(
    [...ctx.scope.tables, { name: sub.from.name, alias: childAlias }],
    ctx.scope.catalog
  );
  threadQueryTypes(sub, subScope.classOf);

  const childLayout = sourceLayout(childAlias, sub.from.name, ctx.scope);
  const childSrc = new SourceNode(
    childAlias,
    sub.from.name,
    childLayout.slots.map(s => s.name)
  );
  ctx.sources.push(childSrc);

  const correlations: { outer: Expr; inner: Expr }[] = [];
  const childLocal: Expr[] = [];
  for (const conj of splitAnd(sub.where)) {
    if (conj.kind === "binary" && conj.op === "=") {
      const corr = asCorrelation(conj, outerAliases, childAliases);
      if (corr) {
        correlations.push(corr);
        continue;
      }
    }
    if (referencesOnly(conj, childAliases)) {
      childLocal.push(conj);
      continue;
    }
    throw new UnsupportedSqlError(
      "EXISTS subquery predicate must be a correlation equality or child-local filter"
    );
  }
  if (correlations.length === 0) {
    throw new UnsupportedSqlError(
      "EXISTS subquery must be correlated to the outer query"
    );
  }

  let child: DataflowNode = childSrc;
  const childPred = andAll(childLocal);
  if (childPred) {
    child = new FilterNode(
      child,
      compilePredicate(childPred, childLayout, ctx.params)
    );
  }

  const classes = correlations.map(c => comparisonClass(c.outer, c.inner));
  return new ExistsNode(
    parent,
    child,
    matchKey(
      correlations.map(c => compileExpr(c.outer, parentLayout, ctx.params)),
      classes
    ),
    matchKey(
      correlations.map(c => compileExpr(c.inner, childLayout, ctx.params)),
      classes
    ),
    ex.negated
  );
}

function asCorrelation(
  conj: Extract<Expr, { kind: "binary" }>,
  outerAliases: ReadonlySet<string>,
  childAliases: ReadonlySet<string>
): { outer: Expr; inner: Expr } | undefined {
  const o = orientBySides(conj.left, conj.right, outerAliases, childAliases);
  return o ? { outer: o.a, inner: o.b } : undefined;
}

function hasAggregateExpr(query: Query): boolean {
  return (
    query.select.some(item => hasAggregate(item.expr)) ||
    (query.having !== undefined && hasAggregate(query.having))
  );
}

function buildAggregate(
  input: DataflowNode,
  inputLayout: Layout,
  query: Query,
  sortBy: OrderItem[],
  ctx: PlanCtx
): {
  node: DataflowNode;
  layout: Layout;
  keyColumns: string[];
  projectItems: SelectItem[];
  sortExprs: Expr[];
} {
  const explicitGroupBy = query.groupBy;
  const groupBy: Expr[] = [...query.groupBy];
  {
    const ungrouped: Extract<Expr, { kind: "column" }>[] = [];
    for (const item of query.select)
      collectUngroupedColumns(item.expr, explicitGroupBy, ungrouped);
    if (query.having)
      collectUngroupedColumns(query.having, explicitGroupBy, ungrouped);
    for (const o of query.orderBy)
      collectUngroupedColumns(o.expr, explicitGroupBy, ungrouped);
    for (const e of ungrouped) {
      const alias = aliasOf(e);
      const table = ctx.scope.aliasToTable.get(alias);
      const pk = table ? ctx.scope.catalog.keyColumnsOf(table) : [];
      const dependent =
        pk.length > 0 &&
        pk.every(c =>
          explicitGroupBy.some(
            g => g.kind === "column" && g.name === c && g.table === alias
          )
        );
      if (!dependent) {
        const spelled = e.table ? `${e.table}.${e.name}` : e.name;
        throw new UnsupportedSqlError(
          `column "${spelled}" must appear in the GROUP BY clause ` +
            "or be used in an aggregate function"
        );
      }
      groupBy.push(e);
    }
  }

  const aggExprs: Expr[] = [];
  for (const item of query.select) collectAggregates(item.expr, aggExprs);
  if (query.having) collectAggregates(query.having, aggExprs);
  for (const o of sortBy) collectAggregates(o.expr, aggExprs);

  const specs: CompiledAggregateSpec[] = aggExprs.map(e =>
    toAggregateSpec(e, inputLayout, ctx)
  );

  const rules: RewriteRule[] = [];
  aggExprs.forEach((e, i) =>
    rules.push({
      match: e,
      replacement: { kind: "column", name: `__agg_${i}`, ptype: e.ptype }
    })
  );
  groupBy.forEach((g, i) =>
    rules.push({
      match: g,
      replacement: { kind: "column", name: `__grp_${i}`, ptype: g.ptype }
    })
  );
  const outLayout = Layout.synthetic([
    ...groupBy.map((_, i) => `__grp_${i}`),
    ...aggExprs.map((_, i) => `__agg_${i}`)
  ]);

  let node: DataflowNode = new AggregateNode(
    input,
    groupBy.map(g => compileExpr(g, inputLayout, ctx.params)),
    groupBy.map(sortClass),
    specs
  );

  if (query.having) {
    node = new FilterNode(
      node,
      compilePredicate(rewriteExpr(query.having, rules), outLayout, ctx.params)
    );
  }

  const projectItems: SelectItem[] = query.select.map(item => ({
    expr: rewriteExpr(item.expr, rules),
    alias: item.alias
  }));
  const sortExprs = sortBy.map(o => rewriteExpr(o.expr, rules));

  const keyColumns: string[] = [];
  for (const item of query.select) {
    if (explicitGroupBy.some(g => exprEquals(g, item.expr)))
      keyColumns.push(item.alias);
  }
  const coversKey = explicitGroupBy.every(g =>
    query.select.some(item => exprEquals(g, item.expr))
  );

  return {
    node,
    layout: outLayout,
    keyColumns: coversKey ? keyColumns : [],
    projectItems,
    sortExprs
  };
}

function toAggregateSpec(
  expr: Expr,
  layout: Layout,
  ctx: PlanCtx
): CompiledAggregateSpec {
  const compile = (e: Expr): CompiledExpr => compileExpr(e, layout, ctx.params);
  const filter = (e: Expr | undefined) =>
    e ? compilePredicate(e, layout, ctx.params) : undefined;
  if (expr.kind === "jsonAgg") {
    return {
      type: "jsonAgg",
      arg: compile(expr.arg),
      orderBy: expr.orderBy?.map(o => ({
        expr: compile(o.expr),
        desc: o.desc,
        nullsFirst: o.nullsFirst,
        cls: orderClass(o.expr)
      })),
      filter: filter(expr.filter)
    };
  }
  if (expr.kind === "aggregate") {
    switch (expr.func) {
      case "count":
        return {
          type: "count",
          arg: expr.arg ? compile(expr.arg) : undefined,
          distinct: expr.distinct,
          cls: expr.arg && sortClass(expr.arg),
          filter: filter(expr.filter)
        };
      case "sum":
        return {
          type: "sum",
          arg: compile(expr.arg!),
          distinct: expr.distinct,
          cls: sortClass(expr.arg!),
          out: expr.ptype!,
          filter: filter(expr.filter)
        };
      case "avg":
        return {
          type: "avg",
          arg: compile(expr.arg!),
          distinct: expr.distinct,
          cls: sortClass(expr.arg!),
          filter: filter(expr.filter)
        };
      case "min":
      case "max":
        return {
          type: expr.func,
          arg: compile(expr.arg!),
          distinct: expr.distinct,
          cls: orderClass(expr.arg!),
          filter: filter(expr.filter)
        };
    }
  }
  throw new UnsupportedSqlError(
    `cannot compile aggregate expression of kind ${expr.kind}`
  );
}

function columnRefIndex(
  items: Iterable<{ expr: Expr; out: string }>
): Map<string, Map<string, string>> {
  const byAlias = new Map<string, Map<string, string>>();
  for (const { expr, out } of items) {
    if (expr.kind !== "column") continue;
    const alias = aliasOf(expr);
    let m = byAlias.get(alias);
    if (!m) byAlias.set(alias, (m = new Map()));
    if (!m.has(expr.name)) m.set(expr.name, out);
  }
  return byAlias;
}

function deriveKeyColumns(
  select: SelectItem[],
  scope: PlanScope,
  correlationAliases: string[],
  discharged: ReadonlySet<string>
): string[] {
  const corr = new Set(correlationAliases);
  const byAlias = columnRefIndex(
    select
      .filter(i => !corr.has(i.alias))
      .map(i => ({ expr: i.expr, out: i.alias }))
  );
  const out: string[] = [];
  for (const [alias, table] of scope.aliasToTable) {
    const m = byAlias.get(alias);
    if (!m) continue;
    const pk = scope.catalog.keyColumnsOf(table);
    if (pk.length > 0 && pk.every(c => m.has(c))) {
      for (const c of pk) out.push(m.get(c)!);
    } else if (!discharged.has(alias)) {
      return [];
    }
  }
  return out;
}

interface Pin {
  alias: string;
  column: string;
  reads: Set<string>;
}

function collectPins(query: Query, scope: PlanScope): Pin[] {
  const pins: Pin[] = [];
  const inScope = new Set(scope.aliasToTable.keys());
  const add = (conj: Expr, allowed: ReadonlySet<string>): void => {
    if (conj.kind !== "binary" || conj.op !== "=") return;
    for (const [col, other] of [
      [conj.left, conj.right],
      [conj.right, conj.left]
    ] as const) {
      if (col.kind !== "column") continue;
      const alias = aliasOf(col);
      if (!allowed.has(alias)) continue;
      const refs = new Set<string>();
      const sawBare = { v: false };
      referencedAliases(other, refs, sawBare);
      if (sawBare.v || refs.has(alias)) continue;
      pins.push({
        alias,
        column: col.name,
        reads: new Set([...refs].filter(a => inScope.has(a)))
      });
    }
  };
  for (const c of splitAnd(query.where)) add(c, inScope);
  const walk = (f: FromItem): Set<string> => {
    if (f.kind !== "join") return new Set([f.alias]);
    const left = walk(f.left);
    const right = walk(f.right);
    const allowed =
      f.joinType === "left" ? right : new Set([...left, ...right]);
    for (const c of splitAnd(f.on)) add(c, allowed);
    return new Set([...left, ...right]);
  };
  walk(query.from);
  return pins;
}

function dischargedAliases(query: Query, scope: PlanScope): Set<string> {
  const pins = collectPins(query, scope);
  const discharged = new Set<string>();
  const keyPinned = (
    alias: string,
    key: string[],
    validPin: (p: Pin) => boolean
  ): boolean =>
    key.length > 0 &&
    key.every(col =>
      pins.some(p => p.alias === alias && p.column === col && validPin(p))
    );
  const keysOf = (alias: string): string[][] =>
    scope.catalog.keysOf(scope.aliasToTable.get(alias)!);
  const pinnable = (alias: string): boolean =>
    keysOf(alias).some(key =>
      keyPinned(alias, key, p => [...p.reads].every(r => resolved.has(r)))
    );
  const resolved = new Set(
    [...scope.aliasToTable.keys()].filter(
      a => !keysOf(a).some(key => keyPinned(a, key, () => true))
    )
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const alias of scope.aliasToTable.keys()) {
      if (resolved.has(alias) || !pinnable(alias)) continue;
      resolved.add(alias);
      discharged.add(alias);
      changed = true;
    }
  }
  return discharged;
}
