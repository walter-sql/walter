import {
  type CollectionSpec,
  type Expr,
  type FromItem,
  type Limit,
  type OrderItem,
  type Query,
  type SelectItem,
  type ShapeQuery,
  UnsupportedSqlError,
  collectTables,
  mapChildren
} from "./ir";
import {
  andAll,
  correlationCoversChildKey,
  equiColumns,
  exprEquals,
  referencedAliases,
  splitAnd
} from "../planner/exprutil";
import type { SchemaCatalog } from "./catalog";

export function liftShape(query: Query, catalog: SchemaCatalog): ShapeQuery {
  const collections: CollectionSpec[] = [];
  let work = query;
  for (;;) {
    const inline = peelInline(work, catalog);
    if (inline) {
      collections.push(inline.spec);
      work = inline.parent;
      continue;
    }

    const sub = findScalarSubCollection(work);
    if (sub) {
      collections.push(
        buildSpecFromBody(sub.body, sub.item.alias, work, catalog)
      );
      work = { ...work, select: work.select.filter(s => s !== sub.item) };
      continue;
    }

    const lat = findLateralCollection(work);
    if (lat) {
      collections.push(
        buildSpecFromBody(lat.body, lat.item.alias, work, catalog)
      );
      const parentFrom = detachJoinRight(work.from, lat.alias);
      if (!parentFrom) {
        throw new UnsupportedSqlError(
          `could not detach lateral collection "${lat.alias}" from FROM`
        );
      }
      work = {
        ...work,
        from: parentFrom,
        select: work.select.filter(s => s !== lat.item)
      };
      continue;
    }

    break;
  }
  return { query: work, collections };
}

interface SubBody {
  obj: Extract<Expr, { kind: "jsonBuildObject" }>;
  object: boolean;
  orderBy: OrderItem[];
  limit?: Limit;
  offset?: Limit;
}

function subBody(body: Query): SubBody | undefined {
  if (body.select.length !== 1) return undefined;
  const e = body.select[0]!.expr;
  const jsonAgg = unwrapJsonAgg(e);
  if (jsonAgg && jsonAgg.arg.kind === "jsonBuildObject") {
    return { obj: jsonAgg.arg, object: false, orderBy: jsonAgg.orderBy ?? [] };
  }
  const obj = throughCoalesce(e, x =>
    x.kind === "jsonBuildObject" ? x : undefined
  );
  if (obj) {
    return {
      obj,
      object: true,
      orderBy: body.orderBy,
      limit: body.limit,
      offset: body.offset
    };
  }
  return undefined;
}

function findScalarSubCollection(
  query: Query
): { item: SelectItem; body: Query } | undefined {
  for (const item of query.select) {
    const body = throughCoalesce(item.expr, e =>
      e.kind === "scalarSubquery" ? e.subquery : undefined
    );
    if (body && subBody(body)) return { item, body };
  }
  return undefined;
}

function findLateralCollection(
  query: Query
): { item: SelectItem; alias: string; body: Query } | undefined {
  const subs: { alias: string; body: Query }[] = [];
  collectSubqueries(query.from, subs);
  for (const L of subs) {
    const sb = subBody(L.body);
    if (!sb || sb.object) continue;
    for (const item of query.select) {
      const col = throughCoalesce(item.expr, e =>
        e.kind === "column" ? e : undefined
      );
      if (col && col.table === L.alias) {
        return { item, alias: L.alias, body: L.body };
      }
    }
  }
  return undefined;
}

function buildChildSpec(args: {
  field: string;
  obj: Extract<Expr, { kind: "jsonBuildObject" }>;
  correlation: CorrPair[];
  parentKey: string[];
  object: boolean;
  source: {
    from: FromItem;
    where: Expr | undefined;
    orderBy: OrderItem[];
    limit?: Limit;
    offset?: Limit;
  };
  catalog: SchemaCatalog;
}): CollectionSpec {
  const childSelect: SelectItem[] = args.obj.pairs.map(p => ({
    expr: p.value,
    alias: p.key
  }));
  const childKey: string[] = [];
  args.correlation.forEach((c, i) => {
    const alias = `__corr_${i}`;
    childSelect.push({ expr: c.child, alias });
    childKey.push(alias);
  });
  const childQuery: Query = {
    from: args.source.from,
    where: args.source.where,
    groupBy: [],
    select: childSelect,
    distinct: false,
    orderBy: args.source.orderBy,
    limit: args.source.limit,
    offset: args.source.offset
  };
  return {
    field: args.field,
    parentKey: args.parentKey,
    childKey,
    object: args.object,
    node: liftShape(childQuery, args.catalog)
  };
}

function rebuildParent(
  query: Query,
  item: SelectItem,
  detached: Detached,
  childAlias: string,
  childAliases: ReadonlySet<string>
): Query {
  const stillUsed = aliasesUsedOutside(query, item).has(childAlias);
  return stillUsed
    ? { ...query, select: query.select.filter(s => s !== item) }
    : {
        ...query,
        from: detached.parentFrom,
        select: query.select.filter(s => s !== item),
        groupBy: query.groupBy.filter(
          g => !referencesSomeColumnFrom(g, childAliases)
        ),
        where: andSplit(query.where, childAliases).parent
      };
}

function buildSpecFromBody(
  body: Query,
  field: string,
  parentQuery: Query,
  catalog: SchemaCatalog
): CollectionSpec {
  const sb = subBody(body)!;
  const src = childSourceOf(body, sb);
  const childAliases = new Set(collectTables(src.from).map(t => t.alias));
  const { correlation, local } = splitChildCorrelation(src.where, childAliases);

  return buildChildSpec({
    field,
    obj: sb.obj,
    correlation,
    parentKey: correlation.map(c => parentAlias(parentQuery, c.parent)),
    object: sb.object,
    source: { ...src, where: local },
    catalog
  });
}

function childSourceOf(
  body: Query,
  sb: SubBody
): {
  from: FromItem;
  where: Expr | undefined;
  orderBy: OrderItem[];
  limit?: Limit;
  offset?: Limit;
} {
  const f = body.from;
  if (f.kind === "subquery") {
    const inner = f.query;
    if (inner.from.kind !== "table") {
      throw new UnsupportedSqlError(
        "a collection derived table must read a single base table"
      );
    }
    if (inner.groupBy.length > 0 || inner.having || inner.distinct) {
      throw new UnsupportedSqlError(
        "a collection derived table cannot group/distinct"
      );
    }
    const innerAlias = inner.from.alias;
    const rename = (e: Expr): Expr => rewriteAlias(e, innerAlias, f.alias);
    const table: FromItem = { ...inner.from, alias: f.alias };
    const where = andAll([
      ...splitAnd(inner.where).map(rename),
      ...splitAnd(body.where)
    ]);
    const orderBy =
      inner.orderBy.length > 0
        ? inner.orderBy.map(o => ({ ...o, expr: rename(o.expr) }))
        : sb.orderBy;
    return {
      from: table,
      where,
      orderBy,
      limit: inner.limit ?? sb.limit,
      offset: inner.offset ?? sb.offset
    };
  }
  return {
    from: f,
    where: body.where,
    orderBy: sb.orderBy,
    limit: sb.limit,
    offset: sb.offset
  };
}

function splitChildCorrelation(
  where: Expr | undefined,
  childAliases: ReadonlySet<string>
): { correlation: CorrPair[]; local: Expr | undefined } {
  const correlation: CorrPair[] = [];
  const local: Expr[] = [];
  for (const conj of splitAnd(where)) {
    const cols = equiColumns(conj);
    if (cols) {
      const lChild = !!cols.left.table && childAliases.has(cols.left.table);
      const rChild = !!cols.right.table && childAliases.has(cols.right.table);
      if (lChild && !rChild) {
        correlation.push({ child: cols.left, parent: cols.right });
        continue;
      }
      if (rChild && !lChild) {
        correlation.push({ child: cols.right, parent: cols.left });
        continue;
      }
    }
    if (referencesSomeColumnFrom(conj, childAliases)) {
      local.push(conj);
      continue;
    }
    throw new UnsupportedSqlError(
      "a collection subquery WHERE conjunct must be child-local or a parent correlation"
    );
  }
  if (correlation.length === 0) {
    throw new UnsupportedSqlError(
      "a collection subquery has no parent correlation"
    );
  }
  return { correlation, local: andAll(local) };
}

function throughCoalesce<T>(
  expr: Expr,
  pick: (e: Expr) => T | undefined
): T | undefined {
  const direct = pick(expr);
  if (direct !== undefined) return direct;
  if (expr.kind === "coalesce") {
    for (const a of expr.args) {
      const r = throughCoalesce(a, pick);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function collectSubqueries(
  from: FromItem,
  out: { alias: string; body: Query }[]
): void {
  if (from.kind === "join") {
    collectSubqueries(from.left, out);
    collectSubqueries(from.right, out);
  } else if (from.kind === "subquery") {
    out.push({ alias: from.alias, body: from.query });
  }
}

function detachJoinRight(from: FromItem, alias: string): FromItem | undefined {
  if (from.kind !== "join") return undefined;
  if (
    (from.right.kind === "table" || from.right.kind === "subquery") &&
    from.right.alias === alias
  ) {
    return from.left;
  }
  const left = detachJoinRight(from.left, alias);
  if (left) return { ...from, left };
  return undefined;
}

function rewriteAlias(e: Expr, from: string, to: string): Expr {
  if (e.kind === "column" && e.table === from) return { ...e, table: to };
  return mapChildren(e, c => rewriteAlias(c, from, to));
}

function unwrapJsonAgg(
  expr: Expr
): Extract<Expr, { kind: "jsonAgg" }> | undefined {
  if (expr.kind === "jsonAgg") return expr;
  if (expr.kind === "coalesce") {
    for (const a of expr.args) {
      const found = unwrapJsonAgg(a);
      if (found) return found;
    }
  }
  return undefined;
}

interface InlineNesting {
  item: SelectItem;
  obj: Extract<Expr, { kind: "jsonBuildObject" }>;
  aliasSource: Expr;
  object: boolean;
  orderBy: OrderItem[];
}

function peelInline(
  query: Query,
  catalog: SchemaCatalog
): { spec: CollectionSpec; parent: Query } | undefined {
  for (const item of query.select) {
    const jsonAgg = unwrapJsonAgg(item.expr);
    const n: InlineNesting | undefined =
      jsonAgg && jsonAgg.arg.kind === "jsonBuildObject"
        ? {
            item,
            obj: jsonAgg.arg,
            aliasSource: jsonAgg,
            object: false,
            orderBy: jsonAgg.orderBy ?? []
          }
        : item.expr.kind === "jsonBuildObject"
          ? {
              item,
              obj: item.expr,
              aliasSource: item.expr,
              object: true,
              orderBy: []
            }
          : undefined;
    if (!n) continue;
    try {
      return peelInlineItem(query, n, catalog);
    } catch (e) {
      if (n.object && e instanceof UnsupportedSqlError) continue;
      throw e;
    }
  }
  return undefined;
}

function peelInlineItem(
  query: Query,
  n: InlineNesting,
  catalog: SchemaCatalog
): { spec: CollectionSpec; parent: Query } {
  const childAliases = new Set<string>();
  referencedAliases(n.aliasSource, childAliases, { v: false });
  if (childAliases.size !== 1) {
    throw new UnsupportedSqlError(
      "a json nesting must read exactly one child table " +
        "(use a LEFT JOIN LATERAL for multi-table or deeper nesting)"
    );
  }
  const childAlias = [...childAliases][0]!;

  const detached = detachChild(query.from, childAlias);
  if (!detached || detached.childFrom.kind !== "table") {
    throw new UnsupportedSqlError(
      `could not locate the join introducing json child "${childAlias}"`
    );
  }
  const correlation = splitCorrelation(detached.on, childAlias);
  const parentKey = correlation.map(c => parentAlias(query, c.parent));

  if (n.object) {
    const childCols = correlation.map(c =>
      c.child.kind === "column" ? c.child.name : ""
    );
    if (
      !correlationCoversChildKey(
        childCols,
        catalog.keysOf(detached.childFrom.name)
      )
    ) {
      throw new UnsupportedSqlError(
        "inline json_build_object join is not unique-key-correlated (fan-out scalar)"
      );
    }
  }

  const parent = rebuildParent(
    query,
    n.item,
    detached,
    childAlias,
    childAliases
  );
  const spec = buildChildSpec({
    field: n.item.alias,
    obj: n.obj,
    correlation,
    parentKey,
    object: n.object,
    source: {
      from: detached.childFrom,
      where: andSplit(query.where, childAliases).child,
      orderBy: n.orderBy
    },
    catalog
  });
  return { spec, parent };
}

function aliasesUsedOutside(query: Query, except: SelectItem): Set<string> {
  const out = new Set<string>();
  const bare = { v: false };
  for (const item of query.select)
    if (item !== except) referencedAliases(item.expr, out, bare);
  if (query.where) referencedAliases(query.where, out, bare);
  if (query.having) referencedAliases(query.having, out, bare);
  for (const g of query.groupBy) referencedAliases(g, out, bare);
  for (const o of query.orderBy) referencedAliases(o.expr, out, bare);
  return out;
}

interface Detached {
  parentFrom: FromItem;
  childFrom: FromItem;
  on: Expr;
}

function detachChild(from: FromItem, childAlias: string): Detached | undefined {
  if (from.kind !== "join") return undefined;
  if (from.right.kind === "table" && from.right.alias === childAlias) {
    return { parentFrom: from.left, childFrom: from.right, on: from.on };
  }
  const left = detachChild(from.left, childAlias);
  if (left) {
    return {
      parentFrom: {
        kind: "join",
        joinType: from.joinType,
        left: left.parentFrom,
        right: from.right,
        on: from.on
      },
      childFrom: left.childFrom,
      on: left.on
    };
  }
  return undefined;
}

interface CorrPair {
  child: Expr;
  parent: Expr;
}

function splitCorrelation(on: Expr, childAlias: string): CorrPair[] {
  const pairs: CorrPair[] = [];
  for (const conj of splitAnd(on)) {
    const cols = equiColumns(conj);
    if (!cols) {
      throw new UnsupportedSqlError(
        "json_agg collection correlation must be an equi-join of plain columns (column = column)"
      );
    }
    const { left, right } = cols;
    if (left.table === childAlias) pairs.push({ child: left, parent: right });
    else if (right.table === childAlias)
      pairs.push({ child: right, parent: left });
    else {
      throw new UnsupportedSqlError(
        "json_agg collection correlation must reference the child table"
      );
    }
  }
  if (pairs.length === 0) {
    throw new UnsupportedSqlError("json_agg collection has no correlation");
  }
  return pairs;
}

function parentAlias(query: Query, parentCol: Expr): string {
  if (parentCol.kind !== "column") {
    throw new UnsupportedSqlError("collection parent key must be a column");
  }
  for (const item of query.select)
    if (exprEquals(item.expr, parentCol)) return item.alias;
  throw new UnsupportedSqlError(
    `collection parent key "${parentCol.name}" must appear in the parent SELECT`
  );
}

function andSplit(
  where: Expr | undefined,
  childAliases: ReadonlySet<string>
): { child: Expr | undefined; parent: Expr | undefined } {
  const child: Expr[] = [];
  const parent: Expr[] = [];
  for (const c of splitAnd(where)) {
    if (referencesSomeColumnFrom(c, childAliases)) child.push(c);
    else parent.push(c);
  }
  return { child: andAll(child), parent: andAll(parent) };
}

function referencesSomeColumnFrom(
  expr: Expr,
  aliases: ReadonlySet<string>
): boolean {
  const set = new Set<string>();
  const bare = { v: false };
  referencedAliases(expr, set, bare);
  if (bare.v) return false;
  for (const a of set) if (!aliases.has(a)) return false;
  return set.size > 0;
}
