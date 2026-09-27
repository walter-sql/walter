---
title: oRPC
description: Add a typed Walter stream to your existing oRPC router and keep TanStack Query current.
section: Build your app
order: 3.1
parent: integrations
---

For an existing oRPC 1.x and TanStack Query 5 app, reuse the [shared client and query](/docs/your-app/). The declared row type carries through to the browser.

## Add a procedure

Add `tasks` to your router. Here, `authed` is your existing procedure that supplies the authenticated `context.user`:

```ts
// server/task-router.ts
import { authed } from "./orpc";
import { walter } from "./walter";
import { myTasks } from "./tasks";

export const tasks = {
  list: authed.handler(async function* ({ context, signal }) {
    yield* walter.stream(myTasks(context.user.id), signal);
  })
};
```

Passing `signal` cancels the Walter subscription when the request ends.

## Use the procedure in a query

Install `@walter-sql/tanstack-query`, then add a hook using your existing typed client and query provider:

```ts
import { useQuery } from "@tanstack/react-query";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { orpc } from "./rpc";

export function useTasks() {
  return useQuery(liveQueryOptions(orpc.tasks.list.queryOptions()));
}
```

Call `useTasks()` in your component. Its `data` is `Task[] | undefined`, updated as messages arrive. Use `data === undefined && !isError` for initial loading; `isFetching` can stay true while streaming.

<details>
<summary>Connect an existing oRPC client to TanStack Query</summary>

Use the matching oRPC TanStack adapter to wrap your typed client with `createTanstackQueryUtils`:

```ts
// browser/rpc.ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { router } from "../server/router";

const client: RouterClient<typeof router> = createORPCClient(
  new RPCLink({ url: new URL("/rpc", location.href) })
);
export const orpc = createTanstackQueryUtils(client);
```

Preserve your client's existing authentication and link options. Server imports here are types only.

</details>

## WebSocket transport

The same procedure and hook work over WebSocket. Keep your existing connection, or use one of these setups:

<details>
<summary>oRPC 1: use a reconnecting browser socket</summary>

Use `RPCHandler` from `@orpc/server/ws` with your authenticated server socket. In the browser, create a shared PartySocket client:

```ts
// browser/rpc.ts
import WebSocket from "partysocket/ws";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { router } from "../server/router";

const url = new URL("/rpc", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
export const socket = new WebSocket(url.href);
const client: RouterClient<typeof router> = createORPCClient(
  new RPCLink({ websocket: socket as globalThis.WebSocket })
);
export const orpc = createTanstackQueryUtils(client);
```

PartySocket reconnects; TanStack Query's retry opens a fresh subscription. Await cancellation of active queries before closing the socket at shutdown.

</details>

<details>
<summary>oRPC 2: use its built-in reconnecting link</summary>

Use `RPCHandler` from `@orpc/server/websocket` on the server. Configure the browser link with:

```ts
import { RPCLink } from "@orpc/client/websocket";

const url = new URL("/rpc", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const link = new RPCLink({
  connect: () => new WebSocket(url.href),
  reconnect: { enabled: true }
});
```

Verified with `2.0.0-beta.37`. Use matching server and client versions; see the [migration guide](https://orpc.dev/docs/migrations/from-v1).

</details>

## Cancellation and recovery

Cancelling a query releases its subscription. On sign-out, also clear private cached data. A `failed` view retains previous rows and sets the query's error state; a later snapshot restores it.

`liveQueryOptions` defaults to retrying errors and opening a new stream on remount. See the [reference](/docs/javascript-client/#tanstack-query-helpers) for these options and [access control](/docs/access-control/) for permission changes.

## Fetch once instead

Use the same procedure for a one-time result:

```ts
import { snapshotQueryOptions } from "@walter-sql/tanstack-query";

const options = snapshotQueryOptions(orpc.tasks.list.queryOptions());
```

This resolves with the first snapshot and closes the stream. The [auction demo](https://github.com/walter-sql/walter/tree/master/examples/demo) contains a complete application.
