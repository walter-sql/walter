---
title: Add live data to your app
description: Connect your server to Walter, open authorized subscriptions, and send updates to the browser.
section: Build your app
order: 1
---

An application subscription begins with a request to your server. The server identifies the user, chooses a query they are allowed to run, and opens a stream from Walter. It then sends those messages to the browser.

Writes continue through your existing endpoints. A successful write reaches the subscription through Postgres replication; the write response and the subscription update arrive independently.

## Put the connection in your server

Install `@walter-sql/client` in the server project and create one `EngineClient` for the process. It shares one WebSocket connection across its subscriptions.

```ts
// server/walter.ts
import { EngineClient } from "@walter-sql/client";

export const walter = new EngineClient(
  process.env.WALTER_URL ?? "ws://127.0.0.1:5544",
  { secret: process.env.WALTER_SECRET }
);
```

Call `walter.close()` when your server shuts down. Do not close this shared client when a single request ends.

## Define a query next to its row type

This example returns unfinished tasks assigned to the signed-in user. It extends the [first query](/docs/quickstart/) with an integer `assignee_id` column.

```ts
// server/tasks.ts
import type { EngineShape } from "@walter-sql/client";

export type Task = {
  id: number;
  title: string;
  done: boolean;
};

export function myTasks(userId: number): EngineShape<Task> {
  return {
    sql: `SELECT id, title, done
          FROM tasks
          WHERE assignee_id = $1 AND NOT done
          ORDER BY id DESC
          LIMIT 20`,
    params: [userId]
  };
}
```

Walter calls the SQL and parameter values together a **shape**. Changing a parameter creates a different query result, so each user in this example has a separate shape.

`EngineShape<Task>` is a TypeScript annotation you supply. It does not infer the result from SQL or validate rows at runtime. Match it to your selected columns and their [JSON types](/docs/types/).

## Open the stream after authentication

Your handler should obtain the user ID from your server's authenticated session. For a handler that supports an async iterable, the subscription code is:

```ts
import { walter } from "./walter";
import { myTasks } from "./tasks";

export function taskMessages(userId: number, signal: AbortSignal) {
  return walter.stream(myTasks(userId), signal);
}
```

The calling endpoint is responsible for authentication and for aborting `signal` when the request closes. Do not use a user ID sent by the browser as proof of identity.

`stream` returns messages containing snapshots, diffs, or a failed result state. Forward those messages through your transport. If the engine rejects the query, iteration throws a `WalterError`; log it on the server and return your API's usual error response. Error details can contain SQL.

The transport-specific guides provide the rest of the handler and browser setup:

- [oRPC and TanStack Query](/docs/orpc-tanstack/) uses an RPC event iterator and a React query cache.
- [Server-sent events and other transports](/docs/other-stacks/) uses a Node HTTP endpoint and the browser's `EventSource` API.

## Apply messages in the browser

Install `@walter-sql/view` in the frontend project. It contains the row-update helpers, with no engine connection.

If your transport gives you an async iterable, consume it with `materialize`:

```ts
import { materialize } from "@walter-sql/view";

// messages is the async iterable returned by your API client.
for await (const view of materialize(messages)) {
  renderTasks(view.rows, view.status);
}
```

Here `messages` and `renderTasks` belong to your app. For a transport that calls you for each message, use the reducer instead:

```ts
import {
  applyView,
  pendingView,
  type View,
  type ViewMessage
} from "@walter-sql/view";
import type { Task } from "../server/tasks";

let view: View<Task> = pendingView;

// Call this from your transport's message callback.
function onMessage(message: ViewMessage<Task>) {
  view = applyView(view, message);
  renderTasks(view.rows, view.status);
}
```

Keep one view value per subscription. A snapshot replaces its rows; a diff updates them. The helpers preserve unchanged row objects, which is useful for UI memoization.

## Handle loading, failures, and disconnections

Before any response, show a loading state. After a successful snapshot, an empty array means the query currently has no matching rows.

A `failed` message means Walter could not evaluate the query. The view helpers retain the previous rows and set `status` to `failed`. Show an error alongside those rows if you keep displaying them. Walter retries, and a successful snapshot restores the result.

Connection state is separate. A view with `status: "live"` may be holding its last result during an outage. Use your browser transport's connection state for a reconnecting indicator. Your server can observe its own engine connection through `walter.status` and `onStatusChange`. See [recovery and monitoring](/docs/operations/) for the distinction.

End the old subscription when the user signs out, leaves the screen, or changes query parameters. Open a new one when the query changes. [Access control](/docs/access-control/) covers permission changes while a subscription is open.
