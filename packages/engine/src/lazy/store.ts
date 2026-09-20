import { stableStringify, type Row } from "../ivm/zset";
import { absorbed, type PgSnapshot } from "./snapshot";

export interface WSRow {
  row: Row;
  snap: PgSnapshot | null;
}

export class WorkingSetStore {
  private readonly ws = new Map<string, Map<string, WSRow>>();

  constructor(
    private readonly keyColumnsByTable: ReadonlyMap<string, readonly string[]>
  ) {}

  pkOf(table: string, row: Row): string {
    const cols = this.keyColumnsByTable.get(table);
    if (!cols || cols.length === 0) return stableStringify(row);
    const picked: Row = {};
    for (const c of cols) picked[c] = row[c];
    return stableStringify(picked);
  }

  get(table: string, pk: string): WSRow | undefined {
    return this.ws.get(table)?.get(pk);
  }

  has(table: string, pk: string): boolean {
    return this.ws.get(table)?.has(pk) ?? false;
  }

  rows(table: string): IterableIterator<WSRow> | [] {
    return this.ws.get(table)?.values() ?? [];
  }

  sizeOf(table: string): number {
    return this.ws.get(table)?.size ?? 0;
  }

  get totalSize(): number {
    let n = 0;
    for (const t of this.ws.values()) n += t.size;
    return n;
  }

  set(table: string, pk: string, row: Row, snap: PgSnapshot | null): void {
    let m = this.ws.get(table);
    if (!m) this.ws.set(table, (m = new Map()));
    m.set(pk, { row, snap });
  }

  delete(table: string, pk: string): void {
    this.ws.get(table)?.delete(pk);
  }

  alreadyReflected(table: string, pk: string, xid: number): boolean {
    const snap = this.get(table, pk)?.snap;
    return snap != null && absorbed(snap, xid);
  }
}
