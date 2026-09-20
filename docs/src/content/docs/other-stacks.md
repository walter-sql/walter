---
title: Server-sent events
description: Stream an authenticated task list over HTTP and apply its updates in the browser without an RPC framework.
section: Build your app
order: 7
---

Server-sent events can carry a Walter subscription from a Node HTTP server to a browser without an RPC framework. The server sends one JSON view message per event, and the browser applies it with `applyView`.

This guide uses `myTasks`, its `Task` type, and the shared `walter` client from [Add live data to your app](/docs/your-app/). It assumes the frontend and `/api/tasks/live` share an origin and your app authenticates requests with its existing session mechanism.

## Add the server handler

This handler accepts a session resolver that returns a user or `null`. Attach the returned function to your existing HTTP server for the task stream route.

```ts
// server/task-sse.ts
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { walter } from "./walter";
import { myTasks } from "./tasks";

type Authenticate = (req: IncomingMessage) => Promise<{ id: number } | null>;

export function taskSseHandler(authenticate: Authenticate) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      const user = await authenticate(req);
      if (res.destroyed) return;
      if (!user) {
        res.writeHead(401).end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders();

      heartbeat = setInterval(() => {
        if (!res.writableNeedDrain) res.write(": keepalive\n\n");
      }, 15_000);

      for await (const message of walter.stream(
        myTasks(user.id),
        controller.signal
      )) {
        if (!res.write(`data: ${JSON.stringify(message)}\n\n`)) {
          await once(res, "drain", { signal: controller.signal });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(error);
        if (res.headersSent) {
          res.write("event: stream-error\ndata: {}\n\n");
        } else {
          res.writeHead(500);
        }
      }
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      res.off("close", abort);
      res.end();
    }
  };
}
```

Route `GET /api/tasks/live` to this handler. It checks authentication before sending event headers, aborts the Walter subscription when the response closes, and waits for the HTTP writer to drain when the consumer falls behind. Heartbeat comments keep idle streams active through proxies that permit them.

The `stream-error` event is an application-level terminal error for this example. It stops the browser from repeatedly retrying a rejected query. A Walter `failed` message remains a normal data event because the engine may recover that query on the same subscription.

## Receive the events

Install `@walter-sql/view` in the frontend. This example renders into a supplied container and returns a cleanup function for navigation or sign-out:

```ts
// browser/tasks.ts
import {
  applyView,
  pendingView,
  type View,
  type ViewMessage
} from "@walter-sql/view";
import type { Task } from "../server/tasks";

export function mountTasks(container: HTMLElement) {
  let view: View<Task> = pendingView;
  let connected = false;
  let terminalError = false;
  const note = document.createElement("p");
  const list = document.createElement("ul");
  container.replaceChildren(note, list);

  const events = new EventSource("/api/tasks/live");

  function render() {
    note.textContent = terminalError
      ? "Could not open the task list."
      : !connected
        ? "Connecting to the task list…"
        : view.status === "failed"
          ? "Tasks could not be updated. The last result is shown."
          : view.status === "pending"
            ? "Loading tasks…"
            : view.rows.length === 0
              ? "No unfinished tasks."
              : "";

    list.replaceChildren(
      ...view.rows.map(task => {
        const item = document.createElement("li");
        item.textContent = task.title;
        return item;
      })
    );
  }

  events.onopen = () => {
    connected = true;
    render();
  };
  events.onmessage = event => {
    const message = JSON.parse(event.data) as ViewMessage<Task>;
    view = applyView(view, message);
    render();
  };
  events.onerror = () => {
    connected = false;
    terminalError = events.readyState === EventSource.CLOSED;
    render();
  };
  events.addEventListener("stream-error", () => {
    terminalError = true;
    events.close();
    render();
  });

  render();
  return () => events.close();
}
```

The browser sends same-origin session cookies with the request. If your app uses a different authentication scheme, adapt the transport accordingly; native `EventSource` does not accept arbitrary request headers.

After a recoverable connection interruption, `EventSource` opens a new request. The server authenticates again and opens a new Walter subscription. Its snapshot replaces the retained rows. This example does not use SSE event IDs to replay changes because Walter has no replay cursor.

## Proxy configuration

Configure your HTTP proxy to stream responses without buffering them and to permit long-lived requests. `X-Accel-Buffering: no` helps with proxies that recognize that header; it does not configure every proxy or hosting platform.

The handler's heartbeat interval is an example transport setting, not a Walter requirement. Choose an interval and timeout policy appropriate to your infrastructure. A serverless request-duration limit may require a different hosting arrangement or periodic reconnects.

## WebSockets and other transports

The same pattern works with an application WebSocket: authenticate the connection or request, select SQL on the server, forward view messages in order, and cancel the upstream subscription when the consumer leaves. Keep separate view state for each subscription if several share a socket.

For a server that consumes rows directly, use `materialize(walter.stream(shape, signal))` without a browser transport.

A server written in another language can connect to the engine's [WebSocket protocol](/docs/wire-protocol/). It must handle replacement snapshots, nested diffs, failures, and reconnects. That connection belongs in the trusted server, just as `EngineClient` does in the JavaScript examples.
