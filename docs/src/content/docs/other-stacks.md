---
title: Node HTTP and SSE
description: Send Walter view messages over server-sent events and consume them in the browser.
section: Build your app
order: 3.9
parent: integrations
---

Use SSE for server-to-browser updates, with writes through your existing API. These examples reuse the [shared client, query, and row type](/docs/your-app/).

## Add the server handler

In your existing Node HTTP handler, authenticate the request before opening the stream:

```ts
import { walter } from "./walter";
import { myTasks } from "./tasks";

// Inside your authenticated GET /api/tasks/live handler:
await walter.pipe(myTasks(user.id), res);
```

`walter.pipe` handles event framing, backpressure, heartbeats, and cancellation. See [Express](/docs/express/), [Fastify](/docs/fastify/), or [Hono](/docs/hono/) for a framework route; the latter two use `walter.response` to return a standard `Response`.

## Receive the events

In the browser, `sseStream` opens the connection and `materialize` builds the current rows:

```ts
import { materialize, sseStream } from "@walter-sql/view";
import type { Task } from "../server/tasks";

const controller = new AbortController();
const messages = sseStream<Task>("/api/tasks/live", {
  signal: controller.signal
});

try {
  for await (const view of materialize(messages)) {
    renderTasks(view.rows, view.status);
  }
} catch (error) {
  showStreamError(error);
}
```

`renderTasks` and `showStreamError` belong to your UI. Abort on navigation or sign-out; breaking out of the loop also closes the stream. Serve the endpoint through the frontend's origin for session cookies. Native `EventSource` cannot set custom request headers.

Network interruptions reconnect automatically and replace the rows with a fresh snapshot. Query errors throw a `WalterError` and close the stream; a refused HTTP response throws `closed`. A `failed` view remains open and can recover.

## Use TanStack Query

Add these options to your existing query setup:

```ts
import { liveQueryOptions, sseStream } from "@walter-sql/tanstack-query";
import type { Task } from "../server/tasks";

export const taskOptions = liveQueryOptions({
  queryKey: ["tasks"],
  queryFn: ({ signal }) => sseStream<Task>("/api/tasks/live", { signal })
});
```

The query data is `Task[]`. TanStack Query supplies cancellation and its retry policy can reopen a failed stream. Clear private cached data on sign-out.

## Proxy configuration

Allow unbuffered, long-lived responses, with an idle timeout longer than the heartbeat interval (15 seconds by default). Serverless request-duration limits may require periodic reconnects or different hosting.

The [SSE reference](/docs/javascript-client/#response-and-pipe) covers options, headers, and error frames.
