import type { TxnBatch } from "../cdc/types";
import { absorbed, type PgSnapshot } from "./snapshot";

const BACKLOG = 1024;

interface Unseen {
  tables: ReadonlySet<string>;
  position: bigint;
}

export class Stream {
  position = 0n;
  onBacklog?: () => void;
  issue?: () => Promise<bigint>;
  private readonly pending = new Map<number, Unseen>();
  private waiters: { target: bigint; resolve: () => void }[] = [];
  private next?: Promise<bigint>;

  fence(): Promise<bigint> {
    return (this.next ??= Promise.resolve().then(() => {
      this.next = undefined;
      return this.issue?.() ?? this.position;
    }));
  }

  received({ xid, position, ops, truncated = [] }: TxnBatch): void {
    if (ops.length + truncated.length > 0) {
      const tables = new Set([...ops.map(op => op.table), ...truncated]);
      this.pending.set(xid, { tables, position });
    }
    this.advance(position);
    if (this.pending.size > BACKLOG) this.onBacklog?.();
  }

  advance(position: bigint): void {
    if (position <= this.position) return;
    this.position = position;
    this.waiters = this.waiters.filter(w => {
      if (w.target > position) return true;
      w.resolve();
      return false;
    });
  }

  reached(target: bigint): Promise<void> {
    if (target <= this.position) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ target, resolve }));
  }

  positioned(): Promise<void> {
    return this.reached(1n);
  }

  unseen(tables: readonly string[], applied: bigint): number[] {
    const xids: number[] = [];
    for (const [xid, txn] of this.pending) {
      if (txn.position <= applied && tables.some(t => txn.tables.has(t)))
        xids.push(xid);
    }
    return xids;
  }

  settle(snap: PgSnapshot): void {
    for (const xid of this.pending.keys()) {
      if (absorbed(snap, xid)) this.pending.delete(xid);
    }
  }
}
