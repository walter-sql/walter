import {
  UnsupportedSqlError,
  forEachExpr,
  mapChildren,
  type Expr,
  type FromItem,
  type Query,
  type SelectItem
} from "./ir";
import type { SchemaCatalog } from "./catalog";
import { hasAggregate } from "../planner/exprutil";

class Scope {
  private readonly entries = new Map<string, string[] | { table: string }>();

  constructor(
    from: FromItem,
    private readonly catalog: SchemaCatalog
  ) {
    const walk = (f: FromItem): void => {
      if (f.kind === "table") this.entries.set(f.alias, { table: f.name });
      else if (f.kind === "subquery") {
        this.entries.set(
          f.alias,
          f.query.select.map(s => s.alias)
        );
      } else {
        walk(f.left);
        walk(f.right);
      }
    };
    walk(from);
  }

  has(alias: string): boolean {
    return this.entries.has(alias);
  }

  aliases(): string[] {
    return [...this.entries.keys()];
  }

  columnsOf(alias: string): readonly string[] {
    const entry = this.entries.get(alias);
    if (entry === undefined) {
      throw new UnsupportedSqlError(
        `cannot expand "${alias}.*": unknown table alias`
      );
    }
    if (Array.isArray(entry)) return entry;
    const cols = this.catalog.columnsOf(entry.table);
    if (!cols) {
      throw new UnsupportedSqlError(
        `star expansion requires catalog columns for table "${entry.table}"`
      );
    }
    return cols;
  }

  shadowed(name: string): boolean {
    return this.aliases().some(a => this.columnsOf(a).includes(name));
  }

  lacksColumn(name: string): boolean {
    return this.aliases().every(a => {
      const cols = this.knownColumns(a);
      return cols !== undefined && !cols.includes(name);
    });
  }

  ownerOf(name: string): string | undefined {
    let owner: string | undefined;
    for (const alias of this.entries.keys()) {
      const cols = this.knownColumns(alias);
      if (!cols) return undefined;
      if (!cols.includes(name)) continue;
      if (owner !== undefined) {
        throw new UnsupportedSqlError(
          `column reference "${name}" is ambiguous`
        );
      }
      owner = alias;
    }
    return owner;
  }

  private knownColumns(alias: string): readonly string[] | undefined {
    const entry = this.entries.get(alias)!;
    return Array.isArray(entry) ? entry : this.catalog.columnsOf(entry.table);
  }
}

export function expandStars(query: Query, catalog: SchemaCatalog): void {
  const scope = new Scope(query.from, catalog);

  const rewrite = (e: Expr): Expr => {
    if (e.kind === "exists" || e.kind === "scalarSubquery") {
      expandStars(e.subquery, catalog);
      return e;
    }
    if (e.kind === "jsonAgg") {
      const alias = wholeRowAlias(e.arg, scope);
      if (alias !== undefined) e = { ...e, arg: rowObject(alias, scope) };
    } else if (e.kind === "wholeRow") {
      const alias = wholeRowAlias(e.arg, scope);
      if (alias === undefined) {
        throw new UnsupportedSqlError(
          `${e.func}() argument must be a FROM alias (t or t.*)`
        );
      }
      return rowObject(alias, scope);
    }
    return mapChildren(e, rewrite);
  };

  const expanded: SelectItem[] = [];
  for (const item of query.select) {
    if (item.expr.kind !== "star") {
      expanded.push({ ...item, expr: rewrite(item.expr) });
      continue;
    }
    const aliases = item.expr.table ? [item.expr.table] : scope.aliases();
    for (const alias of aliases) {
      for (const name of scope.columnsOf(alias)) {
        expanded.push({
          expr: { kind: "column", table: alias, name },
          alias: name
        });
      }
    }
  }
  const seen = new Set<string>();
  for (const item of expanded) {
    if (seen.has(item.alias)) {
      throw new UnsupportedSqlError(
        `select list has duplicate output column "${item.alias}"; ` +
          "qualify with t.* or alias columns explicitly"
      );
    }
    seen.add(item.alias);
  }
  query.select = expanded;

  if (query.where) query.where = rewrite(query.where);
  if (query.having) query.having = rewrite(query.having);
  query.groupBy = query.groupBy.map(rewrite);
  for (const o of query.orderBy) o.expr = rewrite(o.expr);
  resolveTargetRefs(query, scope);
  rewriteFrom(query.from, rewrite, catalog);

  const qualify = (e: Expr): void =>
    forEachExpr(e, n => {
      if (n.kind === "column" && n.table === undefined)
        n.table = scope.ownerOf(n.name);
    });
  for (const item of query.select) qualify(item.expr);
  for (const root of [query.where, query.having]) if (root) qualify(root);
  for (const g of query.groupBy) qualify(g);
  for (const o of query.orderBy) qualify(o.expr);
  qualifyFrom(query.from, qualify);

  for (const item of query.select) assertNoStar(item.expr);
  for (const root of [query.where, query.having]) if (root) assertNoStar(root);
  for (const g of query.groupBy) assertNoStar(g);
  for (const o of query.orderBy) assertNoStar(o.expr);
}

function resolveTargetRefs(query: Query, scope: Scope): void {
  const byPosition = (e: Expr, clause: string): Expr | undefined => {
    if (e.kind !== "literal") return undefined;
    if (e.ptype !== "int" || typeof e.value !== "number") {
      throw new UnsupportedSqlError(`non-integer constant in ${clause}`);
    }
    const item = query.select[e.value - 1];
    if (!item) {
      throw new UnsupportedSqlError(
        `${clause} position ${e.value} is not in select list`
      );
    }
    return item.expr;
  };
  const byAlias = (e: Expr, inputWins: boolean): Expr | undefined => {
    if (e.kind !== "column" || e.table !== undefined) return undefined;
    if (inputWins && !scope.lacksColumn(e.name)) return undefined;
    return query.select.find(s => s.alias === e.name)?.expr;
  };

  for (const o of query.orderBy) {
    o.expr = byPosition(o.expr, "ORDER BY") ?? byAlias(o.expr, false) ?? o.expr;
  }
  for (let i = 0; i < query.groupBy.length; i++) {
    const e = query.groupBy[i]!;
    const target = byPosition(e, "GROUP BY") ?? byAlias(e, true);
    if (target === undefined) continue;
    if (hasAggregate(target)) {
      throw new UnsupportedSqlError(
        "aggregate functions are not allowed in GROUP BY"
      );
    }
    query.groupBy[i] = target;
  }
}

function wholeRowAlias(e: Expr, scope: Scope): string | undefined {
  if (e.kind === "star" && e.table !== undefined && scope.has(e.table)) {
    return e.table;
  }
  if (
    e.kind === "column" &&
    e.table === undefined &&
    scope.has(e.name) &&
    !scope.shadowed(e.name)
  ) {
    return e.name;
  }
  return undefined;
}

function rowObject(alias: string, scope: Scope): Expr {
  return {
    kind: "jsonBuildObject",
    pairs: scope.columnsOf(alias).map(name => ({
      key: name,
      value: { kind: "column", table: alias, name }
    }))
  };
}

function rewriteFrom(
  f: FromItem,
  rewrite: (e: Expr) => Expr,
  catalog: SchemaCatalog
): void {
  if (f.kind === "table") return;
  if (f.kind === "subquery") {
    expandStars(f.query, catalog);
    return;
  }
  f.on = rewrite(f.on);
  assertNoStar(f.on);
  rewriteFrom(f.left, rewrite, catalog);
  rewriteFrom(f.right, rewrite, catalog);
}

function qualifyFrom(f: FromItem, qualify: (e: Expr) => void): void {
  if (f.kind !== "join") return;
  qualify(f.on);
  qualifyFrom(f.left, qualify);
  qualifyFrom(f.right, qualify);
}

function assertNoStar(e: Expr): void {
  forEachExpr(e, n => {
    if (n.kind === "star") {
      throw new UnsupportedSqlError(
        "* is only supported in the select list and in whole-row " +
          "constructors (json_agg(t), to_jsonb(t), row_to_json(t))"
      );
    }
  });
}
