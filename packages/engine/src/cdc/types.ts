import type { Row } from "../ivm/zset";

export interface ChangeOp {
  table: string;
  xid: number;
  kind: "insert" | "update" | "delete";
  newRow?: Row;
  oldRow?: Row;
}

export interface TxnBatch {
  xid: number;
  position: bigint;
  ops: ChangeOp[];
  truncated?: string[];
}

export type AppliedOps = Pick<TxnBatch, "ops" | "position">;
