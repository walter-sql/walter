export type RowValue = Record<string, any>;

export type OrderMove = { from: number; to: number };

export type CollectionOp<TRow extends RowValue = RowValue> =
  | { op: "add"; value: TRow }
  | { op: "remove"; index: number }
  | { op: "update"; index: number; ops: ElementOp[] }
  | { op: "reorder"; moves: OrderMove[] };

export type ElementOp =
  | { op: "set"; field: string; value: unknown }
  | { op: "nest"; field: string; ops: CollectionOp[] }
  | { op: "patch"; field: string; ops: ElementOp[] };

export interface SubscribeMsg {
  type: "subscribe";
  shapeId: string;
  sql: string;
  params?: unknown[];
}

export interface UnsubscribeMsg {
  type: "unsubscribe";
  shapeId: string;
}

export type ClientMessage = SubscribeMsg | UnsubscribeMsg;

export interface SnapshotMsg<TRow extends RowValue = RowValue> {
  type: "snapshot";
  shapeId: string;
  rows: TRow[];
}

export interface DiffMsg<TRow extends RowValue = RowValue> {
  type: "diff";
  shapeId: string;
  changes: CollectionOp<TRow>[];
}

export interface FailedMsg {
  type: "failed";
  shapeId: string;
}

export interface ErrorMsg {
  type: "error";
  shapeId?: string;
  code: "bad_message" | "unsupported_sql" | "parse_error" | "internal";
  message: string;
}

export type ViewMessage<TRow extends RowValue = RowValue> =
  SnapshotMsg<TRow> | DiffMsg<TRow> | FailedMsg;

export type ServerMessage<TRow extends RowValue = RowValue> =
  ViewMessage<TRow> | ErrorMsg;
