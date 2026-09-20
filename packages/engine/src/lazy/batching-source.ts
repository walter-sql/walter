import type { Expr } from "../parser/ir";
import { identityKey } from "../parser/eval";
import { sortClassOf, type SortClass } from "../parser/pgtypes";
import type { SchemaCatalog } from "../parser/catalog";
import type { Row } from "../ivm/zset";
import type { RowSource, SourcedRows, WindowRequest } from "./rowsource";
import { absorbedThrough } from "./snapshot";

interface Waiter {
  keys: readonly (readonly unknown[])[];
  resolve: (r: SourcedRows) => void;
  reject: (e: unknown) => void;
}

interface PendingGroup {
  table: string;
  columns: readonly string[];
  classes: (SortClass | undefined)[];
  keys: Map<string, readonly unknown[]>;
  waiters: Waiter[];
}

export class BatchingRowSource implements RowSource {
  private frame: Map<string, PendingGroup> | null = null;

  constructor(
    private readonly inner: RowSource,
    private readonly catalog: SchemaCatalog
  ) {}

  scopedRows(
    table: string,
    predicate: Expr | undefined,
    params: readonly unknown[]
  ): Promise<SourcedRows> {
    return this.inner.scopedRows(table, predicate, params);
  }

  fetchWindow(req: WindowRequest): Promise<SourcedRows> {
    return this.inner.fetchWindow(req);
  }

  fetchWhereIn(
    table: string,
    columns: readonly string[],
    keys: readonly (readonly unknown[])[]
  ): Promise<SourcedRows> {
    if (keys.length === 0)
      return Promise.resolve({ snap: absorbedThrough(0), rows: [] });

    if (!this.frame) {
      this.frame = new Map();
      queueMicrotask(() => this.flush());
    }
    const gk = `${table}\u0000${columns.join("\u0000")}`;
    let group = this.frame.get(gk);
    if (!group) {
      const classes = columns.map(c =>
        sortClassOf(this.catalog.typeOf(table, c))
      );
      group = { table, columns, classes, keys: new Map(), waiters: [] };
      this.frame.set(gk, group);
    }
    for (const k of keys) group.keys.set(identityKey(k, group.classes), k);
    return new Promise<SourcedRows>((resolve, reject) => {
      group!.waiters.push({ keys, resolve, reject });
    });
  }

  private flush(): void {
    const groups = this.frame;
    this.frame = null;
    if (!groups) return;
    for (const group of groups.values()) this.runGroup(group);
  }

  private runGroup(group: PendingGroup): void {
    const union = [...group.keys.values()];
    this.inner.fetchWhereIn(group.table, group.columns, union).then(
      ({ snap, rows }) => {
        const byVal = new Map<string, Row[]>();
        for (const r of rows) {
          const k = identityKey(
            group.columns.map(c => r[c]),
            group.classes
          );
          let arr = byVal.get(k);
          if (!arr) byVal.set(k, (arr = []));
          arr.push(r);
        }
        for (const w of group.waiters) {
          const subset: Row[] = [];
          const seen = new Set<string>();
          for (const key of w.keys) {
            const k = identityKey(key, group.classes);
            if (seen.has(k)) continue;
            seen.add(k);
            const arr = byVal.get(k);
            if (arr) subset.push(...arr);
          }
          w.resolve({ snap, rows: subset });
        }
      },
      err => {
        for (const w of group.waiters) w.reject(err);
      }
    );
  }
}
