---
title: Configuration
description: Engine settings, defaults, network connections, and programmatic options.
section: Reference
order: 0
---

This page lists the engine's settings and how to change them. For database requirements and startup commands, see [Installation](/docs/installation/).

With Docker or Compose, put these variables in the `walter.env` file used during installation. With the Node.js CLI, set them in the process environment.

## Environment variables

| Variable                | Default     | Purpose                                                                                              |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `WALTER_PG`             | Unset       | Postgres connection string. Required for a node that maintains query results.                        |
| `WALTER_HOST`           | `127.0.0.1` | Address the HTTP and WebSocket server listens on. The Docker image sets this to `0.0.0.0`.           |
| `WALTER_PORT`           | `5544`      | Port for WebSocket connections, health checks, and metrics.                                          |
| `WALTER_SECRET`         | Unset       | Shared secret required on WebSocket handshakes and `/metrics`.                                       |
| `WALTER_DEFAULT_SCHEMA` | `public`    | Default schema for unqualified table names in subscription SQL.                                      |
| `WALTER_TABLES`         | All tables  | Optional comma-separated list restricting which tables Walter serves.                                |
| `WALTER_PEERS`          | Unset       | Comma-separated URLs of the nodes that maintain queries in a cluster. See [Scaling](/docs/scaling/). |
| `WALTER_GRACE_TTL_MS`   | `30000`     | Milliseconds to retain a query after its last subscriber leaves. Use `0` to discard it immediately.  |
| `WALTER_LOG`            | `info`      | Pino log level, such as `debug`, `info`, `warn`, `error`, or `silent`.                               |

Set at least one of `WALTER_PG` and `WALTER_PEERS`. With a database URL and no peers, the engine operates on its own. A node with peers and no database URL relays subscriptions to those peers.

## Apply configuration changes

Walter reads configuration when it starts. A container keeps its original environment when restarted, so recreate it to load changes from `walter.env`.

For Compose:

```bash
docker compose up -d --force-recreate walter
```

For the standalone Docker example, stop and remove the old container, then repeat the [installation command](/docs/installation/#docker) with the updated file:

```bash
docker stop walter
docker rm walter
```

For the Node.js CLI, restart the process with the updated environment. Active query results are rebuilt after a restart; see [Recovery and monitoring](/docs/operations/).

## Network connections

The installation examples make Walter available at `ws://127.0.0.1:5544` on the host. Application servers in the same Compose project can use `ws://walter:5544` without a published host port.

For the Node.js CLI, `WALTER_HOST` defaults to `127.0.0.1`. To accept connections from another host or container, set an appropriate interface, such as `0.0.0.0`. The Docker image already listens on `0.0.0.0` inside the container; Docker's port publishing and network configuration determine who can reach it. Keep access restricted to your application infrastructure.

### Shared secret

Set `WALTER_SECRET` to require a shared secret. With Docker or Compose, add it to `walter.env` and [apply the change](#apply-configuration-changes):

```dotenv
WALTER_SECRET=REPLACE_WITH_YOUR_SECRET
```

Set the same `WALTER_SECRET` value in your application server's environment and pass it to the client:

```ts
const walter = new EngineClient("ws://walter.internal:5544", {
  secret: process.env.WALTER_SECRET
});
```

The secret authenticates a server connection. It does not implement per-user permissions; see [Access control](/docs/access-control/).

### TLS

The built-in server uses HTTP and WebSocket. If you need TLS for this connection, terminate it at your proxy and connect with `wss://`. Configure that proxy to support WebSocket upgrades and long-lived connections.

The database connection string controls the Postgres connection, including its TLS settings. Use the settings required by your database provider.

## Tables and schemas

`WALTER_TABLES` is optional. Leave it unset to use all tables, or set a list such as `public.tasks,public.users` to restrict the publication. The [installation guide](/docs/installation/#configure-the-connection) shows both choices and explains the database setup.

All Walter instances pointing at one database use the publication name `walter_pub`. Leave `WALTER_TABLES` unset on every instance, or give every instance the same list. Startup reconciles the publication with that choice; changing between all-table and explicit-table modes recreates it.

`WALTER_DEFAULT_SCHEMA=app` resolves `FROM tasks` as `app.tasks`. It does not restrict which tables are published. You can also write qualified names such as `app.tasks` directly. Quoted identifiers are supported, including `app."odd.name"`.

Walter reads table definitions at startup. Restart it after changes to published columns, types, keys, or tables, and update application queries and types as needed. See [schema migrations](/docs/operations/#schema-migrations).

## Programmatic API

The engine package also exports a programmatic API:

```ts
import { WalterEngine } from "@walter-sql/engine";

const engine = new WalterEngine({
  pg: process.env.WALTER_PG
});

await engine.start();

// Call during your application's shutdown sequence.
async function stopWalter() {
  await engine.stop();
}
```

The configuration object mirrors the environment variables above, without the `WALTER_` prefix: `pg`, `defaultSchema`, `tables`, `host`, `port`, `secret`, `peers`, and `graceTtlMs`. Pass these values directly; the example reads `WALTER_PG` from the process environment. `engine.stats` exposes current runtime statistics.

Embedding starts the same HTTP and WebSocket service inside your process. Your application is responsible for calling `start()` and `stop()` as part of its lifecycle.

For health checks and recovery, continue with [Recovery and monitoring](/docs/operations/). For several instances, see [Scaling](/docs/scaling/).
