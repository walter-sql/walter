---
title: Hono
description: Return a live query from an existing Hono route using server-sent events.
section: Build your app
order: 3.4
parent: integrations
---

Use Hono 4 on Node.js with the [shared client and query](/docs/your-app/). Here, `requireUser` authenticates the request and sets `c.get("user")`.

## Add the route

```ts
import { sseResponse } from "@walter-sql/client";
import { walter } from "./walter";
import { myTasks } from "./tasks";

app.get("/api/tasks/live", requireUser, c =>
  sseResponse(signal => walter.stream(myTasks(c.get("user").id), signal), {
    signal: c.req.raw.signal
  })
);
```

`sseResponse` handles event framing and heartbeats. Pass the request's signal to cancel the subscription when the client disconnects.

For edge deployments, keep `EngineClient` in a Node service and call it from the edge handler.

## Consume the stream

Follow the [SSE browser example](/docs/other-stacks/#receive-the-events), with `materialize` or TanStack Query. Use the frontend's origin for session cookies and [stream without buffering](/docs/other-stacks/#proxy-configuration).
