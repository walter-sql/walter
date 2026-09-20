---
title: JavaScript API
description: Reference for EngineClient, view reducers, stream helpers, error codes, and TanStack Query adapters.
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

This callback API delivers raw server messages, including `error` frames. It returns a function that ends the subscription. Unlike `stream`, it does not turn errors into exceptions or buffer messages for an async consumer.

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

## TanStack Query helpers

These helpers are exported from `@walter-sql/tanstack-query`. Their input query function must return an async iterable of view messages, or a promise of one.

| Helper                          | Behavior                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveQueryOptions(options)`     | Replaces `queryFn` with a function that updates the query cache as messages arrive. Defaults `refetchOnMount` to `"always"` and `retry` to `true`; explicit options override these defaults. |
| `snapshotQueryOptions(options)` | Replaces `queryFn` with a function that returns the first snapshot and ends the stream.                                                                                                      |
| `liveQueryFn(queryFn)`          | Wraps just the stream-producing query function, leaving the other options to you.                                                                                                            |

The package requires `@tanstack/query-core` >=5, provided by your TanStack Query adapter. The helpers do not open an engine connection. Your query function and transport must pass TanStack's abort signal through to the server subscription.

See [oRPC and TanStack Query](/docs/orpc-tanstack/) for the full integration and cache behavior.

## Errors

`WalterError` has a `code` property and a diagnostic `message`.

| Code              | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bad_message`     | The engine received an invalid protocol message.                                                                     |
| `parse_error`     | The SQL could not be parsed.                                                                                         |
| `unsupported_sql` | The SQL or its parameters cannot be used for this subscription.                                                      |
| `internal`        | An unexpected error occurred while establishing the subscription.                                                    |
| `failed`          | A one-shot helper received a failed view before its first snapshot, or a live TanStack query received a failed view. |
| `closed`          | A one-shot stream ended before a snapshot, or a live TanStack stream ended without cancellation.                     |

The streaming API forwards `failed` as a view message; it does not throw that message as an error. Keep engine diagnostics in server logs rather than returning them directly to browser clients.
