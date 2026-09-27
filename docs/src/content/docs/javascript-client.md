---
title: JavaScript API
description: Reference for EngineClient, view reducers, subscription and SSE helpers, and TanStack Query adapters.
section: Reference
order: 4
---

Use `@walter-sql/client` on a Node.js server to connect to the engine. Use `@walter-sql/view` wherever you consume messages, including the browser, or `@walter-sql/tanstack-query` for TanStack Query. Both the client and TanStack Query packages re-export the view package, so you do not need to install it separately.

For an integration walkthrough, start with [Add live data to your app](/docs/your-app/).

## EngineShape

```ts
interface EngineShape<TRow> {
  sql: string;
  params?: unknown[];
  readonly row?: TRow;
}
```

`TRow` is a record type describing one result row. `params` defaults to an empty array. The optional `row` property carries type information; it is not sent to the engine and does not need a value.

The type is supplied by your code. Walter does not infer it from SQL or validate incoming rows against it.

## EngineClient

```ts
import { EngineClient } from "@walter-sql/client";

const walter = new EngineClient("ws://127.0.0.1:5544", {
  secret: process.env.WALTER_SECRET
});
```

Creating a client starts a WebSocket connection. One client supports multiple subscriptions and reconnects automatically with a delay capped at five seconds. On reconnect it resends active subscriptions, which receive fresh snapshots.

Options:

| Option                            | Purpose                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `secret`                          | Sends the engine's shared secret as `Authorization: Bearer ...`.                                                          |
| `headers`                         | Additional headers for the WebSocket handshake. A supplied `secret` sets the authorization header.                        |
| `onUpgrade(response)`             | Callback for a successful HTTP upgrade, receiving the Node HTTP response.                                                 |
| `onHandshakeRejected(statusCode)` | Callback when the server rejects the handshake, for example because authentication failed. The client continues retrying. |

### stream

```ts
walter.stream(shape, signal?): AsyncIterable<ViewMessage<TRow>>
```

Opens a subscription and returns its view messages: `snapshot`, `diff`, and `failed`. A query rejection throws a `WalterError` during iteration.

Pass an `AbortSignal` to end the subscription when a request closes. Ending the loop with `break` also cleans it up. The subscription opens when `stream` is called, so consume the returned iterable or cancel it; do not create streams and leave them unused.

The stream has a bounded message queue. If a consumer falls behind far enough to fill it, the client discards the backlog and resubscribes for a new snapshot. Consumers must treat every snapshot as a replacement result.

### snapshot

```ts
const rows = await walter.snapshot(shape);
```

Returns the rows from the first snapshot, then unsubscribes. It rejects if the query is refused, if the engine sends `failed` before a snapshot, or if the stream closes first.

This creates a subscription internally. The engine may retain its state for the grace period after this call returns. There is no separate direct-to-Postgres query path in this method.

`snapshot` has no signal argument. If you need cancellation or an application timeout, call `snapshot` from the view package with `walter.stream(shape, signal)`.

### subscribe

```ts
const unsubscribe = walter.subscribe(shape, message => {
  // Handle a ServerMessage synchronously.
});
```

This callback API delivers raw server messages, including `error` frames with the engine's diagnostic text. Keep those raw error frames on the server. It returns a function that ends the subscription. Unlike `stream`, it does not turn errors into exceptions or buffer messages for an async consumer.

Use it when you need to manage the message lifecycle yourself. Most request handlers should use `stream`.

### Connection lifecycle

```ts
walter.status; // "connecting" | "open" | "closed"
const off = walter.onStatusChange(status => console.log(status));
off();
walter.close();
```

`status` describes the socket. `onStatusChange` observes subsequent notifications; read `status` for the current value. It does not report whether each query has received a snapshot or whether Postgres replication is healthy.

`close()` stops reconnecting, removes subscriptions, ends streams, and causes pending snapshot calls with no result to reject. Dispose of the client when its owning server process shuts down.

## View and ViewMessage

```ts
type ViewStatus = "pending" | "live" | "failed";

type View<TRow> = {
  readonly rows: TRow[];
  readonly status: ViewStatus;
};
```

`pendingView` is the initial value, with empty rows and `status: "pending"`.

| Message    | Effect on a view                                     |
| ---------- | ---------------------------------------------------- |
| `snapshot` | Replace rows and set status to `live`.               |
| `diff`     | Apply changes to rows and retain the current status. |
| `failed`   | Retain rows and set status to `failed`.              |

A failed result can recover on the same stream with a snapshot. `live` is not a connection or freshness indicator. See [Recovery and monitoring](/docs/operations/#query-status-and-connection-status).

Diffs contain collection operations (`add`, `remove`, `update`, and `reorder`). Updates can contain these element operations:

```ts
type ElementOp =
  | { op: "set"; field: string; value: any }
  | { op: "nest"; field: string; ops: CollectionOp[] }
  | { op: "patch"; field: string; ops: ElementOp[] };
```

The `set` value is typed as `any` because different fields have different value types; this also lets typed JSON transports preserve the message structure. Values received from Walter are JSON. See the [wire protocol](/docs/wire-protocol/#applying-a-diff) for operation ordering.

### materialize

```ts
import { materialize } from "@walter-sql/view";

for await (const view of materialize(messages)) {
  console.log(view.rows, view.status);
}
```

Converts an async iterable of view messages into an async iterable of views. It emits a value for each incoming message; it does not emit the initial pending value before the first message.

### snapshot from a stream

```ts
import { snapshot } from "@walter-sql/view";

const rows = await snapshot(messages);
```

Returns the first snapshot's rows and ends iteration. It throws a `WalterError` with code `failed` if a failure arrives first, or `closed` if the stream ends before a snapshot. Other exceptions from the source propagate.

### applyView

```ts
const nextView = applyView(previousView, message);
```

A reducer for a single view message. It replaces rows on a snapshot and applies nested changes on a diff. Unchanged row objects are preserved; changed arrays and objects are copied rather than mutating the previous view.

### applyCollection

```ts
const nextRows = applyCollection(previousRows, changes);
```

Applies collection operations without managing view status. Use `applyView` when handling complete view messages. The [wire protocol](/docs/wire-protocol/#applying-a-diff) defines operation ordering for implementations in other languages.

## Callback subscriptions

These exports come from `@walter-sql/view` and are also re-exported by the client and TanStack Query packages.

### subscriptionStream

```ts
function subscriptionStream<TRow extends RowValue = RowValue>(
  subscribe: (sink: Sink<ViewMessage<TRow>>) => () => void,
  signal?: AbortSignal
): AsyncIterable<ViewMessage<TRow>>;
```

Converts a callback subscription into an async iterable for `materialize`, `snapshot`, or `liveQueryOptions`. `subscribe` receives a sink and returns its unsubscribe function. It runs immediately unless the signal is already aborted. Consume the iterable once, or abort it if it will not be consumed.

Aborting the signal unsubscribes immediately. Ending iteration also unsubscribes. Messages already queued are drained before the iterable completes or throws a terminal error.

The queue holds up to 1,000 messages. If another arrives while it is full, the helper clears the backlog, unsubscribes, and calls `subscribe` again. **Each call must open a fresh subscription that starts with a snapshot.** Merely reattaching a listener to a running diff stream is insufficient. The unsubscribe function must stop delivery from the old subscription.

The helper does not create or reconnect a shared application socket. See the [tRPC](/docs/trpc/), [WebSocket](/docs/websocket/), and [Socket.IO](/docs/socket-io/) recipes for adapting existing connections.

### Sink

```ts
interface Sink<T> {
  next(value: T): void;
  error(reason: unknown): void;
  complete(): void;
}
```

`next` delivers a value. `error` ends delivery and makes iteration throw the supplied reason after queued values. `complete` ends delivery normally after queued values. A Walter `failed` message goes through `next`; it is a recoverable view state.

## Server-sent events

### sseStream

Exported from `@walter-sql/view`, and re-exported by the client and TanStack Query packages:

```ts
function sseStream<TRow extends RowValue = RowValue>(
  url: string | URL,
  signal?: AbortSignal
): AsyncIterable<ViewMessage<TRow>>;
```

Opens a native `EventSource` and parses JSON data events. View messages pass through unchanged, including `failed`. Use it in a browser or another runtime that provides `EventSource`. The supplied row type describes the data; it does not validate it.

The connection opens immediately. Abort or end iteration to close it. Temporary connection failures and ordinary response endings leave the iterable open while `EventSource` reconnects; a new server subscription sends a replacement snapshot.

An error frame such as `{"type":"error","code":"parse_error"}` closes the event connection and throws a `WalterError` with that code. It does not reconnect. A refused HTTP response or another terminal `EventSource` failure throws `closed`. A caller such as TanStack Query may separately retry by opening a new stream.

This helper uses `subscriptionStream`, including its queue limit and fresh-subscription behavior. It sends same-origin cookies through the browser's native API. It has no custom-header or cross-origin credential options and does not expose connection-status events.

### writeSSE and sseResponse

Exported from `@walter-sql/client`:

```ts
function writeSSE(
  res: ServerResponse,
  source: MessageSource,
  options?: SseOptions
): Promise<void>;

function sseResponse(source: MessageSource, options?: SseOptions): Response;

type MessageSource = (signal: AbortSignal) => AsyncIterable<ViewMessage>;

interface SseOptions {
  heartbeat?: number;
  signal?: AbortSignal;
}
```

`writeSSE` writes to a Node `ServerResponse` with backpressure. `sseResponse` returns a standard `Response` synchronously, without waiting for the first query result. Both use HTTP 200 and send JSON data events with these headers:

| Header              | Value                    |
| ------------------- | ------------------------ |
| `Content-Type`      | `text/event-stream`      |
| `Cache-Control`     | `no-cache, no-transform` |
| `X-Accel-Buffering` | `no`                     |

`source` receives the helper's abort signal. Pass it to `walter.stream(shape, signal)` so closing the Node response or cancelling the standard response body releases the subscription. In Fetch-style handlers, also pass `{ signal: request.signal }` in the options; this covers a request that ends before the handler returns.

Each message is sent as `data: <json>` followed by a blank line. If the source throws, the helper sends one final error frame and ends the stream:

```text
data: {"type":"error","code":"parse_error"}

```

The frame contains only a code, with no error text or cause. A `WalterError` preserves its code; another thrown error becomes `internal`. Query rejections are handled in the stream and do not reach framework HTTP error handlers. Authentication failures can still return an HTTP error before a helper is called. A `failed` view remains an ordinary data event.

`heartbeat` is the interval in milliseconds between SSE comment frames, defaulting to `15_000`. Heartbeats run while waiting for the first result as well as between updates, and are skipped under backpressure. They do not create new subscriptions. Choose a positive interval suitable for your proxy's idle timeout.

See [Node HTTP and SSE](/docs/other-stacks/) for browser consumption and [proxy configuration](/docs/other-stacks/#proxy-configuration).

## TanStack Query helpers

These helpers are exported from `@walter-sql/tanstack-query`. Their input query function must return an async iterable of view messages, or a promise of one.

| Helper                          | Behavior                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveQueryOptions(options)`     | Replaces `queryFn` with a function that updates the query cache as messages arrive. Defaults `refetchOnMount` to `"always"` and `retry` to `true`; explicit options override these defaults. |
| `snapshotQueryOptions(options)` | Replaces `queryFn` with a function that returns the first snapshot and ends the stream.                                                                                                      |
| `liveQueryFn(queryFn)`          | Wraps just the stream-producing query function, leaving the other options to you.                                                                                                            |

The package requires `@tanstack/query-core` >=5, provided by your TanStack Query adapter. The helpers do not open an engine connection. Your query function and transport must pass TanStack's abort signal through to the server subscription.

Use an async iterable from [oRPC](/docs/orpc-tanstack/), a [tRPC subscription](/docs/trpc/), or [SSE](/docs/other-stacks/#use-tanstack-query). The helper applies the same cache behavior for each transport.

## Errors

`WalterError` has a `code` property and a fixed, client-safe `message`, such as `[walter] parse_error: the engine could not parse this query`.

Construct one with `new WalterError("closed")`. The optional second argument accepts standard `ErrorOptions`, including `{ cause: originalError }`.

For errors thrown by `walter.stream`, `cause` contains the engine's diagnostic on the server. The SSE helpers send only the code, and `sseStream` reconstructs the safe message in the browser.

| Code              | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bad_message`     | The engine received an invalid protocol message.                                                                                     |
| `parse_error`     | The SQL could not be parsed.                                                                                                         |
| `unsupported_sql` | The SQL or its parameters cannot be used for this subscription.                                                                      |
| `internal`        | An unexpected error occurred while establishing the subscription.                                                                    |
| `failed`          | A one-shot helper received a failed view before its first snapshot, or a live TanStack query received a failed view.                 |
| `closed`          | A stream ended before a required result, a live TanStack stream ended without cancellation, or an SSE connection closed permanently. |

The streaming API forwards `failed` as a view message; it does not throw that message as an error. The one-shot `snapshot` helper and TanStack integration turn that state into an error as described above. Keep diagnostic causes in server logs.
