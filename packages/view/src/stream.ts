import { applyView, pendingView, type View } from "./view";
import { WalterError } from "./error";
import type { RowValue, ViewMessage } from "./protocol";

export async function* materialize<TRow extends RowValue = RowValue>(
  source: AsyncIterable<ViewMessage<TRow>>
): AsyncGenerator<View<TRow>> {
  let view: View<TRow> = pendingView;
  for await (const msg of source) yield (view = applyView(view, msg));
}

export async function snapshot<TRow extends RowValue = RowValue>(
  source: AsyncIterable<ViewMessage<TRow>>
): Promise<TRow[]> {
  for await (const msg of source) {
    if (msg.type === "snapshot") return msg.rows;
    if (msg.type === "failed") throw WalterError.failed();
  }
  throw WalterError.closed();
}
