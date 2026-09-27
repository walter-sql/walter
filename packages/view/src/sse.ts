import { WalterError } from "./error";
import { subscriptionStream, type StreamOptions } from "./stream";
import type { RowValue, ServerMessage, ViewMessage } from "./protocol";

export function sseStream<TRow extends RowValue = RowValue>(
  url: string | URL,
  options?: StreamOptions
): AsyncIterable<ViewMessage<TRow>> {
  return subscriptionStream<TRow>(sink => {
    const source = new EventSource(url);
    const fail = (code: WalterError["code"]) => {
      source.close();
      sink.error(new WalterError(code));
    };
    source.onmessage = event => {
      const message: ServerMessage<TRow> = JSON.parse(event.data);
      if (message.type === "error") fail(message.code);
      else sink.next(message);
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) fail("closed");
    };
    return () => source.close();
  }, options);
}
