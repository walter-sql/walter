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
    if (msg.type === "failed") throw new WalterError("failed");
  }
  throw new WalterError("closed");
}

export interface Sink<T> {
  next(value: T): void;
  error(reason: unknown): void;
  complete(): void;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

const MAX_BACKLOG = 1_000;

export function subscriptionStream<TRow extends RowValue = RowValue>(
  subscribe: (sink: Sink<ViewMessage<TRow>>) => () => void,
  { signal }: StreamOptions = {}
): AsyncIterable<ViewMessage<TRow>> {
  const queue: ViewMessage<TRow>[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: { reason: unknown } | null = null;
  let unsubscribe = () => {};

  const notify = () => {
    wake?.();
    wake = null;
  };
  const sink: Sink<ViewMessage<TRow>> = {
    next(value) {
      if (done) return;
      if (queue.length === MAX_BACKLOG) {
        queue.length = 0;
        unsubscribe();
        unsubscribe = subscribe(sink);
        return;
      }
      queue.push(value);
      notify();
    },
    error(reason) {
      if (done) return;
      done = true;
      failure = { reason };
      notify();
    },
    complete() {
      done = true;
      notify();
    }
  };
  const stop = () => {
    signal?.removeEventListener("abort", stop);
    unsubscribe();
    unsubscribe = () => {};
    sink.complete();
  };

  if (signal?.aborted) done = true;
  else {
    unsubscribe = subscribe(sink);
    signal?.addEventListener("abort", stop, { once: true });
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (failure) throw failure.reason;
          if (done) return;
          await new Promise<void>(r => {
            wake = r;
          });
        }
      } finally {
        stop();
      }
    }
  };
}
