---
title: Add live data to your app
description: Your server authorizes a query, subscribes to Walter, and delivers the result through your application's API.
section: Build your app
order: 1
diagram: read-write
---

Keep your existing write endpoints. Set up the shared client and query below, then [choose a recipe](/docs/integrations/) for your server and frontend.

## Put the connection in your server

Install `@walter-sql/client` in your Node.js server. Create one client for the process; it shares a WebSocket across subscriptions and reconnects automatically.

```ts
// server/walter.ts
import { EngineClient } from "@walter-sql/client";

export const walter = new EngineClient(
  process.env.WALTER_URL ?? "ws://127.0.0.1:5544"
);
```

Keep this client for the lifetime of the server process. Call `walter.close()` at shutdown.

## Define a query next to its row type

A **shape** is SQL and its parameter values. A factory is an optional way to build one from inputs. This example uses the [sample table](/docs/quickstart/#pick-a-query) to select unfinished tasks for the signed-in user:

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

The `EngineShape<Task>` return type lets client methods infer the row type; oRPC carries it through to the browser. Match it to the SQL result and its [JSON types](/docs/types/). It does not infer types from SQL or validate rows at runtime. In JavaScript, omit the annotations.

Calling the factory only builds an object. The handler opens the subscription.

## Open the stream after authentication

Inside your handler, use the verified session's user and the request's abort signal:

```ts
import { walter } from "./walter";
import { myTasks } from "./tasks";

const messages = walter.stream(myTasks(user.id), { signal });
```

Forward these messages through your API. The [framework recipes](/docs/integrations/) connect this stream to each transport and cancel it when the consumer leaves. They reuse `walter`, `myTasks`, and `Task` above.

## Apply messages in the browser

Install `@walter-sql/view` in the frontend. Pass the async iterable returned by your API client to `materialize`:

```ts
import { materialize } from "@walter-sql/view";

// messages is the async iterable returned by your API client.
for await (const view of materialize(messages)) {
  renderTasks(view.rows, view.status);
}
```

`renderTasks` belongs to your UI. The recipes provide `messages` through oRPC, [`sseStream`](/docs/javascript-client/#ssestream), or [`subscriptionStream`](/docs/javascript-client/#subscriptionstream). For an existing callback consumer, use [`applyView`](/docs/javascript-client/#applyview) to update its state directly.

## Handle loading, failures, and disconnections

- Show loading until the first result. An empty result then means no matching rows.
- A `failed` view retains previous rows. Show an error while Walter retries; a successful snapshot restores the view.
- A `live` view can hold old rows during an outage. Use connection events, where available, for a reconnecting indicator.

Cancel the subscription on navigation, sign-out, or parameter changes. See [access control](/docs/access-control/) for permission changes and [recovery and monitoring](/docs/operations/) for connection health.
