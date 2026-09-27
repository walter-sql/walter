---
title: Socket.IO
description: Add Walter subscriptions to an existing Socket.IO connection, with independent cancellation and recovery.
section: Build your app
order: 3.6
parent: integrations
---

Use your authenticated Socket.IO 4 connections and the [shared client and query](/docs/your-app/). Each view gets a subscription ID so it can stop independently.

## Register the server handlers

Call `attachTasks(socket, user)` from your authenticated connection handler. Extend your existing event types and routing with:

<details>
<summary>Event types and server handler</summary>

```ts
// shared/task-events.ts
import type { ViewMessage } from "@walter-sql/view";
import type { Task } from "../server/tasks";

export interface TaskRequests {
  "tasks:subscribe": (id: string) => void;
  "tasks:unsubscribe": (id: string) => void;
}

export interface TaskEvents {
  "tasks:view": (
    id: string,
    message: ViewMessage<Task>,
    acknowledge: (applied: true) => void
  ) => void;
  "tasks:error": (id: string) => void;
}
```

```ts
// server/socket-io.ts
import type { Socket } from "socket.io";
import type { TaskEvents, TaskRequests } from "../shared/task-events";
import { walter } from "./walter";
import { myTasks } from "./tasks";

export function attachTasks(
  socket: Socket<TaskRequests, TaskEvents>,
  user: { id: number }
) {
  const active = new Map<string, AbortController>();
  const stop = (id: string) => active.get(id)?.abort();

  socket.on("tasks:subscribe", async id => {
    if (typeof id !== "string") return;
    stop(id);
    const controller = new AbortController();
    active.set(id, controller);

    try {
      for await (const message of walter.stream(myTasks(user.id), {
        signal: controller.signal
      })) {
        if (controller.signal.aborted) break;
        await socket.timeout(10_000).emitWithAck("tasks:view", id, message);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(error);
        if (socket.connected) socket.emit("tasks:error", id);
      }
    } finally {
      controller.abort();
      if (active.get(id) === controller) active.delete(id);
    }
  });
  socket.on("tasks:unsubscribe", stop);
  socket.once("disconnect", () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
  });
}
```

</details>

Acknowledgements limit pending sends. The example ends a subscription after ten seconds without an acknowledgement; adjust this for your workload. Keep origin checks, input validation, and subscription limits in your socket layer.

## Consume a subscription

The adapter uses your shared client from `./io`, typed as `Socket<TaskEvents, TaskRequests>` (or your combined event interfaces):

<details>
<summary>Browser subscription adapter</summary>

```ts
// browser/socket-io.ts
import { subscriptionStream } from "@walter-sql/view";
import type { Task } from "../server/tasks";
import type { TaskEvents } from "../shared/task-events";
import { socket } from "./io";

export function taskStream(signal?: AbortSignal) {
  return subscriptionStream<Task>(
    sink => {
      let id: string | undefined;
      const subscribe = () => {
        id = crypto.randomUUID();
        socket.emit("tasks:subscribe", id);
      };
      const disconnected = () => {
        id = undefined;
      };
      const receive: TaskEvents["tasks:view"] = (
        messageId,
        message,
        acknowledge
      ) => {
        if (!id || messageId !== id) return;
        sink.next(message);
        acknowledge(true);
      };
      const failed = (messageId: string) => {
        if (id && messageId === id)
          sink.error(new Error("Could not open the task list"));
      };

      socket.on("connect", subscribe);
      socket.on("disconnect", disconnected);
      socket.on("tasks:view", receive);
      socket.on("tasks:error", failed);
      if (socket.connected) subscribe();

      return () => {
        socket.off("connect", subscribe);
        socket.off("disconnect", disconnected);
        socket.off("tasks:view", receive);
        socket.off("tasks:error", failed);
        if (id && socket.connected) socket.emit("tasks:unsubscribe", id);
      };
    },
    { signal }
  );
}
```

</details>

Pass `taskStream(signal)` to `materialize` or [`liveQueryOptions`](/docs/javascript-client/#tanstack-query-helpers). Abort when the view leaves; the shared socket stays open.

## Recovery

Each reconnect starts a new subscription and replaces the view with a snapshot. New IDs keep old responses out of the current view. The callback also supports `subscriptionStream`'s [restart behavior](/docs/javascript-client/#subscriptionstream).

If connection-state recovery is enabled, set [`connectionStateRecovery.skipMiddlewares`](https://socket.io/docs/v4/connection-state-recovery/#skipmiddlewares-option) to `false` so authentication runs again.

Abort consumers on sign-out. [Access control](/docs/access-control/#account-for-permission-changes) covers permission changes while connected.
