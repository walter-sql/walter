---
title: Express
description: Add a live query to an existing Express route using server-sent events.
section: Build your app
order: 3.2
parent: integrations
---

Use your Express 5 app with the [shared client and query](/docs/your-app/). Here, `requireUser` authenticates the request and sets `req.user`.

## Add the route

```ts
import { writeSSE } from "@walter-sql/client";
import { walter } from "./walter";
import { myTasks } from "./tasks";

app.get("/api/tasks/live", requireUser, (req, res) =>
  writeSSE(res, signal => walter.stream(myTasks(req.user.id), signal))
);
```

`writeSSE` handles event framing, heartbeats, backpressure, and cancellation when the response closes.

## Consume the stream

Follow the [SSE browser example](/docs/other-stacks/#receive-the-events), with `materialize` or TanStack Query. Use the frontend's origin for session cookies, and allow [unbuffered responses](/docs/other-stacks/#proxy-configuration) through middleware and proxies.
