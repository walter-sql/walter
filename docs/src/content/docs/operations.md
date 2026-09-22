---
title: Recovery and monitoring
description: Understand reconnects, failed queries, migrations, health endpoints, and the metrics available in production.
section: Operations
order: 2
---

Walter recovers query results by reading them again from Postgres. Consumers must accept a replacement snapshot at any point in a subscription.

There are several connections in an application: Postgres to Walter, Walter to your server, and your server to the browser. Recovery on one connection does not report the health of the others.

## What happens during an interruption

| Event                                         | What the consumer sees                                                            | Recovery                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Engine restart or server-to-engine disconnect | Its last rows remain until the connection recovers.                               | `EngineClient` reconnects and resubscribes. Each active subscription receives a snapshot.                                       |
| Postgres replication disconnect or timeout    | Results can remain visible without updates; `/ready` returns 503.                 | Walter reconnects with a new slot and rebuilds results.                                                                         |
| Query evaluation fails                        | A `failed` message. View helpers keep the previous rows and mark the view failed. | The engine retries the query, from one second up to a one-minute delay between attempts. A successful rebuild sends a snapshot. |
| A published table is truncated                | Subscriptions using it receive replacement results.                               | Walter rebuilds affected results.                                                                                               |
| Browser-to-server disconnect                  | Depends on the transport and UI.                                                  | Your transport must reopen the subscription. The oRPC and SSE guides show this lifecycle.                                       |

Row reads and connection attempts to a vanished Postgres host fail after about 20 seconds. The replication connection times out after about 60 seconds without a message, making `/ready` return 503.

## Query status and connection status

The view helpers expose `pending`, `live`, and `failed`:

- `pending`: no successful snapshot has arrived yet.
- `live`: a successful snapshot has arrived, and no later query failure has been reported.
- `failed`: the engine reported that this result could not be evaluated.

These describe the result, not current connectivity. A `live` view can contain old rows during an outage. A replication outage does not itself send a `failed` message.

Use your frontend transport's events to show browser connectivity. On the server, use `EngineClient.status` and `onStatusChange` to observe the engine socket. Monitor the engine's replication readiness separately.

If your application needs a freshness guarantee, define how it will detect and handle stale data across these connections. There is no timestamp or replication position in a view message from which to calculate end-to-end lag.

## Rejected queries

A rejected subscription is different from a failed result. Invalid syntax and unsupported SQL cause `stream` to throw a `WalterError`. The application needs to fix the request; reopening the same invalid query will not make it supported.

An accepted query can fail later, for example because new data causes division by zero. It remains subscribed while the engine retries. The failure's details appear in the engine log, and the consumer receives a `failed` message without those details.

See the [JavaScript API](/docs/javascript-client/#errors) for error codes and the one-shot API's behavior.

## Schema migrations

Walter reads columns, types, and keys at startup. It does not automatically reload them after a migration.

When a migration changes a published schema:

1. Update application queries and row types for the intended schema.
2. Apply the migration using your normal deployment process.
3. If you use `WALTER_TABLES`, update that list when the set of served tables changes.
4. Restart the Walter instances connected to that database so they read the new definitions. If their environment changed, [recreate the containers](/docs/configuration/#apply-configuration-changes) with the updated settings.
5. Confirm that active subscriptions receive new snapshots and inspect the logs for rejected or failed queries.

Coordinate application and engine versions for incompatible changes. Restarting the engine does not make an old query valid against a removed or renamed column. In a cluster, plan for the affected results to rebuild as each owner restarts; see [Scaling](/docs/scaling/#deployments-and-membership-changes).

## Health endpoints

The engine serves these HTTP endpoints on its WebSocket port:

| Endpoint       | Behavior                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /live`    | HTTP 200 while the engine responds, even before Postgres connects or during replication loss.                                                                                        |
| `GET /ready`   | HTTP 503 at startup or after connection loss, until a new replication slot exists; HTTP 200 otherwise, even while results rebuild. A relay-only node has no local replication check. |
| `GET /metrics` | Prometheus text metrics. Requires `Authorization: Bearer <secret>` when `WALTER_SECRET` is configured.                                                                               |

`/live` and `/ready` do not require the shared secret. Keep them on the same restricted network as the engine.

The `ghcr.io/walter-sql/engine` image includes a Docker healthcheck against `/live`; no custom healthcheck is needed. Do not replace it with `/ready`: Docker Swarm (used by Dokploy) would repeatedly restart the engine during a Postgres outage, dropping app-server connections instead of letting it reconnect automatically. In Kubernetes, configure liveness probes for `/live` and readiness probes for `/ready`, since Kubernetes ignores Docker healthchecks.

A ready relay does not prove that all of its owners are reachable. For a cluster, check each owner and test a representative subscription through the serving path.

## Metrics and logs

These metrics help explain load and recovery:

| Metric                                                   | Meaning                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `walter_replication_connected`                           | 1 once the replication slot exists; 0 during startup or recovery. Absent on relay-only nodes.                                                          |
| `walter_stream_activity_timestamp_seconds`               | Last replication activity; updates at least every 10 seconds when healthy. Over a minute old indicates a problem. Does not measure consumer freshness. |
| `walter_shapes`, `walter_shapes_failed`                  | Maintained query results and how many are failed.                                                                                                      |
| `walter_subscribers`                                     | Subscribers to locally maintained results, including subscriptions arriving from peers.                                                                |
| `walter_relay_shapes`, `walter_relay_subscribers`        | Results and subscribers served by relaying to owners.                                                                                                  |
| `walter_working_set_rows`                                | Source rows retained by locally maintained queries. It is not a byte count or a count of unique database rows across all queries.                      |
| `walter_backlog_ops`                                     | Queued change operations, counted for affected queries. Can be zero during a replication outage while results are stale.                               |
| `walter_send_queue_frames`, `walter_send_buffered_bytes` | Outgoing messages waiting to be sent.                                                                                                                  |
| `walter_seeds_total`, `walter_seed_seconds_total`        | Successful initial result builds and their cumulative duration.                                                                                        |
| `walter_reseeds_total`                                   | Rebuilds requested after replication resets or truncation for results not already failed.                                                              |
| `process_resident_memory_bytes`                          | Process memory, including more than the source rows.                                                                                                   |

Walter writes structured JSON logs for startup, connection changes, query creation and failures, and recovery. Once a minute it logs a summary of runtime statistics. Query failure logs include the SQL, so apply your normal controls for access to server logs.

Use these measurements to establish thresholds for your workload. [Memory and performance](/docs/performance/) describes what to measure.

## Temporary replication slots

Each database-connected instance creates a temporary logical replication slot. Postgres removes it when that replication session ends. After reconnecting, Walter creates a new slot and rebuilds results instead of replaying an old slot's history.

A slow active replication consumer can still cause Postgres to retain WAL. Monitor database replication and WAL usage as you would for other replication clients. A temporary slot does not make active replication free of database cost.

## Delivery and consistency

Walter processes committed database changes. A subscription may receive one diff for several commits, and a commit that does not change its result produces no diff. Snapshots replace state after recovery; they do not replay every change that happened during the interruption.

Each snapshot or diff leaves the result consistent with one moment in the database, including joins and nested collections. Separate subscriptions can reflect different moments.

The stream is intended to maintain a current query result. It is not a durable event log. Separate subscriptions have no shared transaction identifier, and there is no API to wait for a particular write to appear in a subscription. If your UI needs an immediate confirmation of a write, use its mutation response and handle the subsequent live update as part of your application's state management.
