---
title: oRPC and TanStack Query
description: Connect an authenticated oRPC subscription to a React task list with TanStack Query.
section: Build your app
order: 6
---

This guide connects a server subscription to a React task list. oRPC carries the messages from the server, and the Walter TanStack Query helpers keep the cached rows up to date.

It uses `myTasks` and the shared `walter` client from [Add live data to your app](/docs/your-app/). The examples assume sibling `server` and `browser` directories so the browser can import server types. In a monorepo, use your existing type-only package exports instead.

## Install the packages

In the server project:

```bash
npm install @walter-sql/client @orpc/server
```

In the React project:

```bash
npm install @walter-sql/tanstack-query @orpc/client @orpc/tanstack-query @tanstack/react-query
```

The browser example also imports the `RouterClient` type from `@orpc/server`. Make that package available to its TypeScript build; it is a type-only import.

## Define an authenticated procedure

The server's request context contains a user resolved by your existing authentication code. The procedure checks that user and uses their ID to choose the task result.

```ts
// server/router.ts
import { ORPCError, os } from "@orpc/server";
import { walter } from "./walter";
import { myTasks } from "./tasks";

export type Context = {
  user: { id: number } | null;
};

const authed = os.$context<Context>().use(({ context, next }) => {
  if (!context.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { user: context.user } });
});

export const router = {
  tasks: {
    list: authed.handler(async function* ({ context, signal }) {
      yield* walter.stream(myTasks(context.user.id), signal);
    })
  }
};
```

Passing `signal` to `stream` connects request cancellation to the Walter subscription. When the request ends, the subscription can be released.

## Mount the router

This Node HTTP adapter accepts your application's session resolver as an argument. It should return the authenticated user or `null`; do not obtain the user ID from an unverified request parameter.

```ts
// server/http.ts
import { createServer, type IncomingMessage } from "node:http";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { router, type Context } from "./router";

export function createTaskServer(
  authenticate: (request: IncomingMessage) => Promise<Context["user"]>
) {
  const handler = new RPCHandler(router, {
    interceptors: [onError(error => console.error(error))]
  });

  return createServer(async (req, res) => {
    try {
      const user = await authenticate(req);
      const { matched } = await handler.handle(req, res, {
        prefix: "/rpc",
        context: { user }
      });
      if (!matched) res.writeHead(404).end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
```

Call `createTaskServer` with your session resolver and start it on your application's port, or mount `RPCHandler` in an existing server. Serve `/rpc` through the same origin as the frontend, including through a development proxy when the frontend and backend use different ports.

The error interceptor records rejected Walter queries on the server. oRPC converts unrecognized errors into its generic internal error response. Avoid an error formatter that exposes the original SQL or engine error message to the browser.

## Create the browser client

```ts
// browser/rpc.ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { router } from "../server/router";

const link = new RPCLink({ url: `${location.origin}/rpc` });
const client: RouterClient<typeof router> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
```

The imports from the server are types only. The engine client and database credentials stay on the server.

## Render the live rows

```tsx
// browser/TaskApp.tsx
import {
  QueryClient,
  QueryClientProvider,
  useQuery
} from "@tanstack/react-query";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { orpc } from "./rpc";

const queryClient = new QueryClient();

function Tasks() {
  const { data: tasks, isError } = useQuery(
    liveQueryOptions(orpc.tasks.list.queryOptions())
  );

  if (tasks === undefined && !isError) return <p>Loading tasks…</p>;

  return (
    <section>
      {isError && <p>Tasks could not be updated. The last result is shown.</p>}
      {tasks?.length === 0 && <p>No unfinished tasks.</p>}
      <ul>
        {tasks?.map(task => (
          <li key={task.id}>{task.title}</li>
        ))}
      </ul>
    </section>
  );
}

export function TaskApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tasks />
    </QueryClientProvider>
  );
}
```

If the app already has a `QueryClientProvider`, use that provider and mount `Tasks` inside it.

`data` is the current task array. `liveQueryOptions` applies each snapshot or diff to the query cache. The query function stays active while it reads the stream, so `isFetching` can remain true after the first result; do not use it alone as the initial loading indicator.

## Cancellation and reconnects

The transport receives TanStack's abort signal. When the last observer leaves and the query is cancelled, that signal closes the request and the server subscription. Cached rows can remain available for a later mount.

`liveQueryOptions` defaults `refetchOnMount` to `"always"` so a remount opens a stream, and `retry` to `true` so a failed stream can reopen. You can override these options, but a query with retained cached rows and no active stream will not receive new updates.

A `failed` view sets the query's error state while retaining its data. The same stream can recover with a new snapshot. A transport exception follows TanStack's retry behavior. These are separate from a server-to-engine or replication interruption, which may leave the last result visible without an immediate frontend error.

On sign-out or account changes, cancel the old user's queries and remove their cached private data using your application's existing session lifecycle. Server-side access changes also need the handling described in [Access control](/docs/access-control/).

## Fetch once instead

Use the same procedure as a one-time request:

```ts
import { snapshotQueryOptions } from "@walter-sql/tanstack-query";

const options = snapshotQueryOptions(orpc.tasks.list.queryOptions());
```

This resolves with the first snapshot and ends the stream. It is useful when a screen needs one result but does not need live updates.

The repository's [auction demo](https://github.com/walter-sql/walter/tree/master/examples/demo) includes the same integration with a complete server, React app, session handling, and write endpoints.
