---
title: tRPC
description: Add a typed Walter subscription to your existing tRPC router and query cache.
section: Build your app
order: 3.7
parent: integrations
---

Use your existing tRPC 11 router and client, with the [shared Walter client and query](/docs/your-app/).

## Add a subscription procedure

Add `tasks` to your router. Here, `authed` supplies the authenticated `ctx.user`:

```ts
// server/task-procedure.ts
import { authed } from "./trpc";
import { walter } from "./walter";
import { myTasks } from "./tasks";

export const tasks = authed.subscription(async function* ({ ctx, signal }) {
  yield* walter.stream(myTasks(ctx.user.id), signal);
});
```

The request's abort signal closes its Walter subscription. Rejected queries follow tRPC's error handling.

## Consume the subscription

Wrap the typed client's callback subscription with `subscriptionStream`:

```ts
// browser/task-stream.ts
import { subscriptionStream } from "@walter-sql/view";
import type { Task } from "../server/tasks";
import { trpc } from "./trpc";

export function taskStream(signal?: AbortSignal) {
  return subscriptionStream<Task>(
    sink =>
      trpc.tasks.subscribe(undefined, {
        onData: sink.next,
        onError: sink.error,
        onComplete: sink.complete
      }).unsubscribe,
    signal
  );
}
```

The returned iterable works with `materialize`, or with your existing TanStack Query setup:

```ts
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { taskStream } from "./task-stream";

export const taskOptions = liveQueryOptions({
  queryKey: ["tasks"],
  queryFn: ({ signal }) => taskStream(signal)
});
```

The query data is `Task[]`. Cancelling it unsubscribes without closing the shared client. Existing callback consumers can also use [`applyView`](/docs/javascript-client/#applyview) in `onData`.

## Choose the application transport

Keep your current subscription link. If you need to add one, either transport works with the same procedure:

<details>
<summary>Add SSE to an HTTP client</summary>

Keep your server adapter and authenticated context. In the browser, route subscriptions through `httpSubscriptionLink`:

```ts
// browser/trpc.ts
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink
} from "@trpc/client";
import type { AppRouter } from "../server/trpc-router";

export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: operation => operation.type === "subscription",
      true: httpSubscriptionLink({ url: "/trpc" }),
      false: httpBatchLink({ url: "/trpc" })
    })
  ]
});
```

Preserve your existing link options. Same-origin requests carry session cookies. See [proxy settings](/docs/other-stacks/#proxy-configuration) and tRPC's [connection options](https://trpc.io/docs/client/links/httpSubscriptionLink).

</details>

<details>
<summary>Use a shared WebSocket client</summary>

Use tRPC's [WebSocket server adapter](https://trpc.io/docs/server/websockets) with your session context and origin checks. Share one browser client:

```ts
// browser/trpc.ts
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "../server/trpc-router";

const url = new URL("/trpc", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
export const socket = createWSClient({ url: url.href });
export const trpc = createTRPCClient<AppRouter>({
  links: [wsLink({ client: socket })]
});
```

Use `splitLink` if queries and mutations should stay on HTTP. tRPC restores subscriptions after reconnecting. Call `socket.close()` at application shutdown.

</details>

## Recovery and cancellation

Cancel subscriptions and clear private cached data on sign-out. Reopened subscriptions receive a replacement snapshot; Walter does not replay missed diffs.

The callback passed to `subscriptionStream` must open a new subscription each time. See the [reference](/docs/javascript-client/#subscriptionstream) for queue limits and restart behavior.
