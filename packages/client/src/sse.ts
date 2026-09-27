import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WalterError, type ViewMessage } from "@walter-sql/view";

export type MessageSource = (signal: AbortSignal) => AsyncIterable<ViewMessage>;

export interface SseOptions {
  heartbeat?: number;
  signal?: AbortSignal;
}

type Frame = ViewMessage | { type: "error"; code: WalterError["code"] };

const HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no"
};
const HEARTBEAT = ": \n\n";
const frame = (msg: Frame) => `data: ${JSON.stringify(msg)}\n\n`;
const failure = (error: unknown): Frame => ({
  type: "error",
  code: error instanceof WalterError ? error.code : "internal"
});

function sseBody(
  source: MessageSource,
  { heartbeat = 15_000, signal }: SseOptions = {}
): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const iterator = source(controller.signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  let cancelled = false;
  const end = () => {
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    abort();
  };
  return new ReadableStream({
    start(stream) {
      timer = setInterval(() => {
        if ((stream.desiredSize ?? 0) > 0)
          stream.enqueue(encoder.encode(HEARTBEAT));
      }, heartbeat);
    },
    async pull(stream) {
      try {
        const result = await iterator.next();
        if (cancelled) return;
        if (!result.done)
          return stream.enqueue(encoder.encode(frame(result.value)));
      } catch (error) {
        stream.enqueue(encoder.encode(frame(failure(error))));
      }
      end();
      stream.close();
    },
    cancel() {
      cancelled = true;
      end();
    }
  });
}

export function sseResponse(
  source: MessageSource,
  options?: SseOptions
): Response {
  return new Response(sseBody(source, options), { headers: HEADERS });
}

export async function writeSSE(
  res: ServerResponse,
  source: MessageSource,
  options?: SseOptions
): Promise<void> {
  const readable = Readable.fromWeb(sseBody(source, options));
  res.writeHead(200, HEADERS);
  await pipeline(readable, res).catch(() => readable.destroy());
}
