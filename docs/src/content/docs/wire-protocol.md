---
title: Wire protocol
description: JSON WebSocket messages, subscription lifecycle, nested diff operations, and custom-client recovery.
section: Reference
order: 5
---

This is the protocol between the Walter engine and a trusted application server. JavaScript servers can use `EngineClient`; other implementations can use this reference.

Messages are JSON text frames over WebSocket. If `WALTER_SECRET` is configured, the upgrade request must include `Authorization: Bearer <secret>`. The engine rejects handshakes with an `Origin` header.

## Subscribe and unsubscribe

Choose a `shapeId` that is unique among active subscriptions on the connection. This is a client-chosen identifier, not the engine's internal query fingerprint.

```json
{
  "type": "subscribe",
  "shapeId": "tasks-1",
  "sql": "SELECT id, title FROM tasks WHERE NOT done ORDER BY id DESC LIMIT 20",
  "params": []
}
```

`params` is optional and defaults to `[]`. To stop:

```json
{ "type": "unsubscribe", "shapeId": "tasks-1" }
```

Unsubscribing an unknown ID has no effect. Subscribing an already active ID returns `bad_message`; a custom client should use a new ID for each active subscription.

## Snapshots

A successful initial result is sent as a snapshot:

```json
{
  "type": "snapshot",
  "shapeId": "tasks-1",
  "rows": [
    { "id": 42, "title": "Review the migration" },
    { "id": 41, "title": "Update the changelog" }
  ]
}
```

Replace the subscription's entire result when a snapshot arrives. A later snapshot is valid too: recovery, rebuilds, and resets can all replace the result during an existing subscription.

An accepted query can fail before its first successful result, so a `failed` message can arrive before the first snapshot.

## Diffs

A diff changes the previously received result:

```json
{
  "type": "diff",
  "shapeId": "tasks-1",
  "changes": [
    {
      "op": "update",
      "index": 0,
      "ops": [{ "op": "set", "field": "title", "value": "Migration reviewed" }]
    }
  ]
}
```

This edits the title of the first row. Diffs are emitted when the result changes. They may combine several committed transactions, and they contain no transaction or replay position.

### Collection operations

The outer result and nested arrays use these operations:

| Operation | Fields                | Meaning                                                            |
| --------- | --------------------- | ------------------------------------------------------------------ |
| `add`     | `value`               | Append a row. A later reorder can move it to its display position. |
| `remove`  | `index`               | Remove a row at its pre-diff index.                                |
| `update`  | `index`, `ops`        | Apply element operations to a row at its pre-diff index.           |
| `reorder` | `moves: [{from, to}]` | Reposition rows after updates, removals, and additions.            |

### Element operations

| Operation | Fields           | Meaning                                                              |
| --------- | ---------------- | -------------------------------------------------------------------- |
| `set`     | `field`, `value` | Replace a field's value, including a scalar, null, object, or array. |
| `nest`    | `field`, `ops`   | Apply collection operations to a nested array.                       |
| `patch`   | `field`, `ops`   | Apply element operations to a nested object.                         |

For example, a comment edit can appear as an outer `update`, a `nest` on the `comments` field, an `update` for the comment, and a `set` for its body. The view package handles that recursion.

### Applying a diff

At each collection, apply operations in this order, regardless of their order in the message:

1. Apply `update` operations using the existing row indices.
2. Apply `remove` operations in descending index order.
3. Append `add` values.
4. Apply `reorder` operations to the resulting array.

For a reorder, take every `from` element from the same array before any moves are applied. Remove those elements together, then insert them at their `to` positions in ascending `to` order.

For example, removing index 1 from `[A, B, C]` and adding `D` produces `[A, C, D]`. A move `{ "from": 2, "to": 0 }` then produces `[D, A, C]`. The reorder indices refer to the array after removals and additions, not the original `[A, B, C]`.

[`applyCollection` in the view package](https://github.com/walter-sql/walter/blob/master/packages/view/src/view.ts) is the implementation reference. Do not sort the local array independently or drop individual diffs: subsequent indices depend on the maintained order.

## Failed results

```json
{ "type": "failed", "shapeId": "tasks-1" }
```

Keep the last rows, if any, and mark this view as failed. The subscription remains active. The engine retries, and a successful snapshot replaces the rows and clears the failed state.

The message contains no diagnostic detail. The cause is recorded in the engine log. A replication or transport disconnect is a separate condition and does not necessarily produce a failed message.

## Errors

```json
{
  "type": "error",
  "shapeId": "tasks-1",
  "code": "unsupported_sql",
  "message": "..."
}
```

| Code              | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `bad_message`     | Invalid JSON, invalid message fields, or a duplicate active subscription ID. |
| `parse_error`     | The SQL could not be parsed.                                                 |
| `unsupported_sql` | The SQL or parameters cannot be used for this subscription.                  |
| `internal`        | Unexpected error while establishing the subscription.                        |

A refused new subscription is not active. Correct it before retrying. A malformed message can produce an error without `shapeId`, so error handling must also exist at the connection level.

Error text may contain SQL or database details. Keep it in trusted server logs instead of forwarding it directly to browser clients.

## Reconnect and reset

The protocol has no resume token, acknowledgement, or replay offset. After reconnecting, send the active subscriptions again and accept their replacement snapshots.

Use a new view for a new subscription. If you have lost a diff or no longer trust your local state, unsubscribe and subscribe again to obtain a snapshot; continuing to apply indexed diffs to incomplete state can corrupt the result.

The engine sends WebSocket ping frames to detect unresponsive connections. A slow connection whose outgoing queue overflows is closed with code `1013`. Reconnect and resubscribe in that case too.

For a custom browser transport, preserve message ordering per subscription, cancel upstream work when the consumer leaves, and establish a new subscription after a transport interruption. The [SSE guide](/docs/other-stacks/) provides an example.
