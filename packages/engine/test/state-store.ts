import {
  emptyZSet,
  stableStringify,
  zsetAddRow,
  type Row,
  type ZSet
} from "../src/ivm/zset";
import type { ChangeOp } from "../src/cdc/types";

export type RowOp = Omit<ChangeOp, "xid">;

export class StateStore {
  private readonly mem = new Map<string, Map<string, Row>>();
  private readonly keyColumns = new Map<string, string[]>();

  setKeyColumns(table: string, columns: string[]): void {
    this.keyColumns.set(table, columns);
  }

  keyColumnsOf(table: string): string[] {
    return this.keyColumns.get(table) ?? [];
  }

  allKeyColumns(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [t, cols] of this.keyColumns) out[t] = cols;
    return out;
  }

  private table(name: string): Map<string, Row> {
    let t = this.mem.get(name);
    if (!t) {
      t = new Map();
      this.mem.set(name, t);
    }
    return t;
  }

  private pkOf(table: string, row: Row): string {
    const cols = this.keyColumns.get(table);
    if (!cols || cols.length === 0) return stableStringify(row);
    const picked: Row = {};
    for (const c of cols) picked[c] = row[c];
    return stableStringify(picked);
  }

  rows(table: string): IterableIterator<Row> {
    return this.table(table).values();
  }

  ingest(ops: RowOp[]): Map<string, ZSet> {
    const deltas = new Map<string, ZSet>();

    const deltaFor = (table: string): ZSet => {
      let z = deltas.get(table);
      if (!z) {
        z = emptyZSet();
        deltas.set(table, z);
      }
      return z;
    };

    for (const op of ops) {
      const t = this.table(op.table);
      const z = deltaFor(op.table);
      if (op.kind === "insert") {
        const row = op.newRow!;
        const pk = this.pkOf(op.table, row);
        const prev = t.get(pk);
        if (prev) zsetAddRow(z, prev, -1);
        zsetAddRow(z, row, 1);
        t.set(pk, row);
      } else if (op.kind === "update") {
        const row = op.newRow!;
        const newPk = this.pkOf(op.table, row);
        const oldPk = this.pkOf(op.table, op.oldRow!);
        const prev = t.get(oldPk);
        if (prev) zsetAddRow(z, prev, -1);
        zsetAddRow(z, row, 1);
        if (oldPk !== newPk) t.delete(oldPk);
        t.set(newPk, row);
      } else {
        const oldPk = this.pkOf(op.table, op.oldRow!);
        const prev = t.get(oldPk);
        if (prev) {
          zsetAddRow(z, prev, -1);
          t.delete(oldPk);
        }
      }
    }

    return deltas;
  }
}
