import {
  UnsupportedSqlError,
  collectTables,
  type Expr,
  type FromItem
} from "../parser/ir";
import {
  compileAliasPredicate,
  compileRowPredicate,
  type AliasRows
} from "../planner/compile";
import { compareSortKeys, identityKey } from "../parser/eval";
import { sortClassOf, type SortClass } from "../parser/pgtypes";
import { SchemaCatalog } from "../parser/catalog";
import type { Row } from "../ivm/zset";
import { absorbedThrough, type PgSnapshot } from "./snapshot";
import { wcol, type Reveal, type WindowRead } from "./window";

export interface SourcedRows {
  snap: PgSnapshot;
  rows: Row[];
}

export interface WindowPartition {
  value: readonly unknown[];
  after?: readonly unknown[];
}

export function corrValue(row: Row, cols: readonly string[]): unknown[] {
  return cols.map(c => row[c]);
}

function matchesReveal(
  env: AliasRows,
  reveal: Reveal,
  classes: readonly (readonly (SortClass | undefined)[])[]
): boolean {
  return reveal.some((g, i) => {
    const vals = g.columns.map(c => {
      const v = env[c.alias]?.[c.column];
      return v === undefined ? null : v;
    });
    const vk = identityKey(vals, classes[i]!);
    return g.tuples.some(t => identityKey(t, classes[i]!) === vk);
  });
}

export interface WindowRequest extends WindowRead {
  correlationColumns: readonly string[];
  partitions: WindowPartition[];
  params: readonly unknown[];
  reveal?: Reveal;
}

export interface RowSource {
  scopedRows(
    table: string,
    predicate: Expr | undefined,
    params: readonly unknown[]
  ): Promise<SourcedRows>;

  fetchWhereIn(
    table: string,
    columns: readonly string[],
    keys: readonly (readonly unknown[])[]
  ): Promise<SourcedRows>;

  fetchWindow(req: WindowRequest): Promise<SourcedRows>;
}

export class MemRowSource implements RowSource {
  constructor(
    private readonly getRows: (table: string) => Iterable<Row>,
    private readonly snap: () => PgSnapshot = () => absorbedThrough(0),
    private readonly catalog = new SchemaCatalog()
  ) {}

  private classes(
    table: string,
    cols: readonly string[]
  ): (SortClass | undefined)[] {
    return cols.map(c => sortClassOf(this.catalog.typeOf(table, c)));
  }

  async scopedRows(
    table: string,
    predicate: Expr | undefined,
    params: readonly unknown[]
  ): Promise<SourcedRows> {
    const pred = predicate ? compileRowPredicate(predicate, params) : undefined;
    const rows: Row[] = [];
    for (const row of this.getRows(table)) {
      if (!pred || pred(row)) rows.push(row);
    }
    return { snap: this.snap(), rows };
  }

  async fetchWhereIn(
    table: string,
    columns: readonly string[],
    keys: readonly (readonly unknown[])[]
  ): Promise<SourcedRows> {
    const classes = this.classes(table, columns);
    const wanted = new Set(keys.map(k => identityKey(k, classes)));
    const rows: Row[] = [];
    for (const row of this.getRows(table)) {
      const k = identityKey(
        columns.map(c => row[c]),
        classes
      );
      if (wanted.has(k)) rows.push(row);
    }
    return { snap: this.snap(), rows };
  }

  async fetchWindow(req: WindowRequest): Promise<SourcedRows> {
    const { order, correlationColumns, reveal } = req;
    const where = req.fetch.where
      ? compileAliasPredicate(req.fetch.where, req.params)
      : undefined;

    const tableOf = new Map(
      collectTables(req.fetch.from).map(t => [t.alias, t.name])
    );
    const revealClasses = (reveal ?? []).map(g =>
      g.columns.map(c =>
        sortClassOf(this.catalog.typeOf(tableOf.get(c.alias)!, c.column))
      )
    );
    const partClasses = this.classes(req.anchorTable, correlationColumns);

    const byPart = new Map<string, { anchor: Row; tuple: unknown[] }[]>();
    for (const env of this.evalFrom(req.fetch.from, req.params)) {
      if (where && !where(env)) continue;
      if (reveal !== undefined && !matchesReveal(env, reveal, revealClasses))
        continue;
      const anchor = env[req.anchorAlias]!;
      const tuple = order.map(k => {
        const v = env[k.alias]?.[k.column];
        return v === undefined ? null : v;
      });
      const k = identityKey(corrValue(anchor, correlationColumns), partClasses);
      let g = byPart.get(k);
      if (!g) byPart.set(k, (g = []));
      g.push({ anchor, tuple });
    }

    const out: Row[] = [];
    for (const part of req.partitions) {
      const k = identityKey(part.value, partClasses);
      const g = byPart.get(k);
      if (!g) continue;
      let rows: { anchor: Row; tuple: unknown[] }[];
      if (reveal !== undefined) {
        rows = part.after
          ? g.filter(r => compareSortKeys(r.tuple, part.after!, order) <= 0)
          : g.slice();
      } else {
        rows = part.after
          ? g.filter(r => compareSortKeys(r.tuple, part.after!, order) > 0)
          : g.slice();
      }
      rows.sort((a, b) => compareSortKeys(a.tuple, b.tuple, order));
      if (reveal === undefined) rows = rows.slice(0, req.pageSize);
      for (const r of rows) {
        const row: Row = { ...r.anchor };
        order.forEach((key, i) => {
          if (!key.anchor) row[wcol(i)] = r.tuple[i];
        });
        out.push(row);
      }
    }
    return { snap: this.snap(), rows: out };
  }

  private evalFrom(from: FromItem, params: readonly unknown[]): AliasRows[] {
    if (from.kind === "table") {
      const rows: AliasRows[] = [];
      for (const row of this.getRows(from.name)) {
        rows.push({ [from.alias]: row });
      }
      return rows;
    }
    if (from.kind === "subquery") {
      throw new UnsupportedSqlError(
        "window fetch spec cannot contain a subquery"
      );
    }
    const left = this.evalFrom(from.left, params);
    const right = this.evalFrom(from.right, params);
    const on = compileAliasPredicate(from.on, params);
    const out: AliasRows[] = [];
    for (const l of left) {
      let matched = false;
      for (const r of right) {
        const merged = { ...l, ...r };
        if (on(merged)) {
          out.push(merged);
          matched = true;
        }
      }
      if (!matched && from.joinType === "left") out.push(l);
    }
    return out;
  }
}
