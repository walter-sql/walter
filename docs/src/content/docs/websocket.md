---
title: WebSocket
description: Add independent Walter subscriptions to an existing application WebSocket.
section: Build your app
order: 3.5
parent: integrations
---

Use your authenticated application socket and the [shared client and query](/docs/your-app/). Give each view its own subscription ID so it can stop without closing the connection.

If your app already routes subscriptions by ID, keep that protocol. The adapters below show a complete example using `ws` and PartySocket.

## Forward subscriptions on the server

Call `attachTasks(socket, user)` from your authenticated connection handler. The query uses the verified user; each subscription has its own abort controller.

<details>
<summary>Message types and server handler</summary>

```ts
// shared/task-messages.ts
import type { ViewMessage } from "@walter-sql/view";
import type { Task } from "../server/tasks";

export type TaskRequest =
  | { type: "tasks:subscribe"; id: string }
  | { type: "tasks:unsubscribe"; id: string };

export type TaskEvent =
  | { type: "tasks:view"; id: string; message: ViewMessage<Task> }
  | { type: "tasks:error"; id: string };
```

The application ID is separate from Walter's upstream `shapeId`.

```ts
// server/task-socket.ts
import type { WebSocket } from "ws";
import type { TaskEvent } from "../shared/task-messages";
import { walter } from "./walter";
import { myTasks } from "./tasks";

export function attachTasks(socket: WebSocket, user: { id: number }) {
  const active = new Map<string, AbortController>();
  const stop = (id: string) => active.get(id)?.abort();
  const send = (event: TaskEvent) =>
    new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(event), error =>
        error ? reject(error) : resolve()
      );
    });

  async function start(id: string) {
    stop(id);
    const controller = new AbortController();
    active.set(id, controller);

    try {
      for await (const message of walter.stream(myTasks(user.id), {
        signal: controller.signal
      })) {
        if (controller.signal.aborted) break;
        await send({ type: "tasks:view", id, message });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(error);
        await send({ type: "tasks:error", id }).catch(() => {});
      }
    } finally {
      controller.abort();
      if (active.get(id) === controller) active.delete(id);
    }
  }

  socket.on("message", data => {
    let request;
    try {
      request = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!request || typeof request.id !== "string") return;
    if (request.type === "tasks:subscribe") void start(request.id);
    if (request.type === "tasks:unsubscribe") stop(request.id);
  });
  socket.once("close", () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
  });
}
```

</details>

The handler waits for each send and cancels subscriptions on disconnect. Keep input validation and subscription limits in your socket layer. [Access control](/docs/access-control/) covers authorization and permission changes.

## Consume a subscription

The browser adapter uses your shared PartySocket instance from `./socket`:

<details>
<summary>Browser subscription adapter</summary>

```ts
// browser/task-socket.ts
import { subscriptionStream } from "@walter-sql/view";
import type { Task } from "../server/tasks";
import type { TaskEvent, TaskRequest } from "../shared/task-messages";
import { socket } from "./socket";

export function taskStream(signal?: AbortSignal) {
  return subscriptionStream<Task>(
    sink => {
      let id: string | undefined;
      const send = (request: TaskRequest) =>
        socket.send(JSON.stringify(request));
      const subscribe = () => {
        id = crypto.randomUUID();
        send({ type: "tasks:subscribe", id });
      };
      const disconnected = () => {
        id = undefined;
      };
      const receive = (event: MessageEvent) => {
        const message = JSON.parse(event.data) as TaskEvent;
        if (!id || message.id !== id) return;
        if (message.type === "tasks:view") sink.next(message.message);
        if (message.type === "tasks:error")
          sink.error(new Error("Could not open the task list"));
      };

      socket.addEventListener("open", subscribe);
      socket.addEventListener("close", disconnected);
      socket.addEventListener("message", receive);
      if (socket.readyState === 1) subscribe();

      return () => {
        socket.removeEventListener("open", subscribe);
        socket.removeEventListener("close", disconnected);
        socket.removeEventListener("message", receive);
        if (id && socket.readyState === 1)
          send({ type: "tasks:unsubscribe", id });
      };
    },
    { signal }
  );
}
```

</details>

Pass `taskStream(signal)` to `materialize` or [`liveQueryOptions`](/docs/javascript-client/#tanstack-query-helpers). Abort when the view leaves; this removes only its own listeners and subscription.

<details>
<summary>Create a shared reconnecting socket</summary>

```ts
// browser/socket.ts
import WebSocket from "partysocket/ws";

const url = new URL("/socket", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
export const socket = new WebSocket(url.href);
```

Accept this path through your authenticated upgrade handler. The [ws examples](https://github.com/websockets/ws#client-authentication) cover session and origin checks.

</details>

## Recovery

After reconnection, each consumer requests a fresh snapshot with a new ID. Earlier messages are ignored. The `subscriptionStream` callback must open a new subscription each time; see its [restart behavior](/docs/javascript-client/#subscriptionstream).

Abort consumers before closing the shared socket on sign-out or shutdown.
