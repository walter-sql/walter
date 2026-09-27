---
title: Fastify
description: Return a live query from an existing Fastify route using server-sent events.
section: Build your app
order: 3.3
parent: integrations
---

Use your Fastify 5 app with the [shared client and query](/docs/your-app/). Here, `requireUser` authenticates the request and sets `request.user`.

## Add the route

```ts
import { sseResponse } from "@walter-sql/client";
import { walter } from "./walter";
import { myTasks } from "./tasks";

app.get("/api/tasks/live", { preHandler: requireUser }, request =>
  sseResponse(signal => walter.stream(myTasks(request.user.id), signal))
);
```

`sseResponse` handles event framing, heartbeats, and cancellation. Return its standard `Response` directly.

## Consume the stream

Follow the [SSE browser example](/docs/other-stacks/#receive-the-events), with `materialize` or TanStack Query. Use the frontend's origin for session cookies and [stream without buffering](/docs/other-stacks/#proxy-configuration).
