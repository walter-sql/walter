import type { Expr, FromItem, Query } from "../parser/ir";
import { UnsupportedSqlError } from "../parser/ir";
import type { SortClass } from "../parser/pgtypes";
import type { PlanScope } from "../planner/scope";
import { compileRowPredicate } from "../planner/compile";
import { comparisonClass } from "../planner/types";
import {
  aliasesOf,
  andAll,
  equiColumns,
  nullableAliases,
  orientBySides,
  referencedAliases,
  splitAnd,
  splitJoinCondition
} from "../planner/exprutil";

export interface LazySource {
  alias: string;
  table: string;
  keyColumns: string[];
  localPred?: Expr;
  isDim: boolean;
}

export interface PullEdge {
  puller?: { table: string; cols: string[] };
  dimTable: string;
  dimCols: string[];
  classes: (SortClass | undefined)[];
}

export interface AnchorPull {
  table: string;
  columns: string[];
  classes: (SortClass | undefined)[];
}

export interface LazyPlan {
  sources: LazySource[];
  byTable: Map<string, LazySource>;
  edges: PullEdge[];
}

interface RawEdge {
  aAlias: string;
  aCols: string[];
  bAlias: string;
  bCols: string[];
  classes: SortClass[];
}

export function analyzeLazyTree(
  query: Query,
  scope: PlanScope,
  params: readonly unknown[],
  anchor?: AnchorPull
): LazyPlan {
  const { aliasToTable } = scope;
  const byTable = new Map<string, LazySource>();
  for (const { name, alias } of scope.tables) {
    if (byTable.has(name)) {
      throw new UnsupportedSqlError(
        `lazy sourcing does not support self-joins (table ${name} used by multiple aliases)`
      );
    }
    byTable.set(name, {
      alias,
      table: name,
      keyColumns: scope.catalog.keyColumnsOf(name),
      isDim: false
    });
  }

  const conjuncts = splitAnd(query.where);
  const existsConjuncts: Extract<Expr, { kind: "exists" }>[] = [];
  const localByAlias = new Map<string, Expr[]>();
  const nullable = nullableAliases(query.from);
  for (const c of conjuncts) {
    if (c.kind === "exists") {
      existsConjuncts.push(c);
      continue;
    }
    const alias = singleAliasOf(c, aliasToTable);
    if (!alias) continue;
    if (nullable.has(alias) && compileRowPredicate(c, params)({})) continue;
    let arr = localByAlias.get(alias);
    if (!arr) localByAlias.set(alias, (arr = []));
    arr.push(c);
  }
  for (const [alias, preds] of localByAlias) {
    const table = aliasToTable.get(alias)!;
    byTable.get(table)!.localPred = andAll(preds);
  }

  const rawEdges: RawEdge[] = [];
  collectJoinEdges(query.from, rawEdges);

  const edges: PullEdge[] = [];
  const bounded = new Set<string>();
  if (anchor) {
    edges.push({
      dimTable: anchor.table,
      dimCols: anchor.columns,
      classes: anchor.classes
    });
    byTable.get(anchor.table)!.isDim = true;
    bounded.add(anchor.table);
  } else {
    for (const s of byTable.values()) if (s.localPred) bounded.add(s.table);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const e of rawEdges) {
      const aT = aliasToTable.get(e.aAlias);
      const bT = aliasToTable.get(e.bAlias);
      if (!aT || !bT) continue;
      const aB = bounded.has(aT);
      const bB = bounded.has(bT);
      if (aB === bB) continue;
      const [puller, dim] = aB
        ? [
            { table: aT, cols: e.aCols },
            { table: bT, cols: e.bCols }
          ]
        : [
            { table: bT, cols: e.bCols },
            { table: aT, cols: e.aCols }
          ];
      edges.push({
        puller,
        dimTable: dim.table,
        dimCols: dim.cols,
        classes: e.classes
      });
      byTable.get(dim.table)!.isDim = true;
      bounded.add(dim.table);
      changed = true;
    }
  }

  for (const ex of existsConjuncts) {
    const { childAlias, childTable, edges: exEdges } = existsEdges(ex, scope);
    if (byTable.has(childTable)) {
      throw new UnsupportedSqlError(
        `lazy sourcing does not support self-joins (table ${childTable} used by multiple aliases)`
      );
    }
    byTable.set(childTable, {
      alias: childAlias,
      table: childTable,
      keyColumns: scope.catalog.keyColumnsOf(childTable),
      isDim: true
    });
    edges.push(...exEdges);
  }

  return { sources: [...byTable.values()], byTable, edges };
}

function singleAliasOf(
  expr: Expr,
  aliasToTable: ReadonlyMap<string, string>
): string | undefined {
  const set = new Set<string>();
  referencedAliases(expr, set, { v: false });
  if (set.size !== 1) return undefined;
  const [alias] = set;
  return aliasToTable.has(alias!) ? alias : undefined;
}

function collectJoinEdges(from: FromItem, out: RawEdge[]): void {
  if (from.kind !== "join") return;
  collectJoinEdges(from.left, out);
  collectJoinEdges(from.right, out);
  const { equiKeys } = splitJoinCondition(
    from.on,
    aliasesOf(from.left),
    aliasesOf(from.right)
  );
  const byPair = new Map<string, RawEdge>();
  for (const { left, right } of equiKeys) {
    if (left.kind !== "column" || right.kind !== "column") continue;
    const key = `${left.table}\u0000${right.table}`;
    let e = byPair.get(key);
    if (!e) {
      byPair.set(
        key,
        (e = {
          aAlias: left.table!,
          aCols: [],
          bAlias: right.table!,
          bCols: [],
          classes: []
        })
      );
    }
    e.aCols.push(left.name);
    e.bCols.push(right.name);
    e.classes.push(comparisonClass(left, right));
  }
  if (byPair.size === 0) {
    throw new UnsupportedSqlError(
      "lazy sourcing requires an equi-join condition (column = column)"
    );
  }
  for (const e of byPair.values()) out.push(e);
}

function existsEdges(
  ex: Extract<Expr, { kind: "exists" }>,
  scope: PlanScope
): { childAlias: string; childTable: string; edges: PullEdge[] } {
  const sub = ex.subquery;
  if (sub.from.kind !== "table") {
    throw new UnsupportedSqlError(
      "EXISTS subqueries must read from a single table"
    );
  }
  const childAliases = new Set([sub.from.alias]);
  const outerAliases = new Set(scope.aliasToTable.keys());
  const byOuter = new Map<string, Required<PullEdge>>();
  for (const conj of splitAnd(sub.where)) {
    const cols = equiColumns(conj);
    if (!cols) continue;
    const o = orientBySides(cols.left, cols.right, outerAliases, childAliases);
    if (!o || o.a.kind !== "column" || o.b.kind !== "column") continue;
    const outerAlias = o.a.table!;
    let e = byOuter.get(outerAlias);
    if (!e) {
      byOuter.set(
        outerAlias,
        (e = {
          puller: { table: scope.aliasToTable.get(outerAlias)!, cols: [] },
          dimTable: sub.from.name,
          dimCols: [],
          classes: []
        })
      );
    }
    e.puller.cols.push(o.a.name);
    e.dimCols.push(o.b.name);
    e.classes.push(comparisonClass(o.a, o.b));
  }
  if (byOuter.size === 0) {
    throw new UnsupportedSqlError(
      "lazy sourcing requires a column-equality correlation in EXISTS"
    );
  }
  return {
    childAlias: sub.from.alias,
    childTable: sub.from.name,
    edges: [...byOuter.values()]
  };
}
