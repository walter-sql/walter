---
title: When to use Walter
description: Decide whether live query results fit your application, database, and operational needs.
section: Background
order: 2
---

Walter is useful when your application stores data in Postgres and needs to keep query results current while someone is viewing them. Examples include task lists, shared dashboards, activity feeds, and detail screens with related records.

The main decision is whether maintaining a server-side query result matches what your application needs. You can answer that without adopting a particular frontend framework.

## A typical fit

Walter fits an application that already has a Postgres database and an API server. That server can authenticate users, choose their queries, and keep a stream open to each consumer.

It is especially relevant when several tables contribute to a screen. A task with an assignee and recent comments can be one subscription, with the joins and nesting computed in the engine.

Your write path remains in your application. Updates made by background workers and other database clients are observed too, so each writer does not need to know which screens are subscribed.

## Check these requirements first

| Requirement                    | What it means for your application                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Logical replication            | Your Postgres host must support it, with the required settings, permissions, and connection capacity.            |
| Supported SQL                  | Check the actual queries your application needs, including ORM output. Walter does not support all Postgres SQL. |
| A trusted server               | Browser requests go through your server, which chooses SQL and enforces access control.                          |
| Long-lived connections         | The server and any proxies need to support the chosen streaming transport.                                       |
| Memory for active queries      | A limited response can still need a large source dataset. Measure representative queries.                        |
| Recovery through new snapshots | After interruptions, a result can pause and then be replaced with a fresh one.                                   |

## When another approach may fit better

**Occasional refreshes.** If data changes infrequently and a page can refresh every minute, polling may be enough. A streaming service adds a process and a connection lifecycle to operate.

**Offline editing.** Walter does not include an on-device database, a queue of offline writes, or conflict resolution. You would need to build those features or use a system that provides them.

**A durable event history.** Walter streams the changing result of a query. It can combine commits and replace state with a snapshot after an interruption. It is not an event log for processing every change exactly once.

**Immediate local writes.** Your UI can implement optimistic updates, but Walter does not manage them or correlate a mutation response with a particular stream update. Writes and live results are separate paths.

**Broad analytical SQL.** Check the SQL reference before choosing Walter for reporting workloads. Window functions, recursive queries, set operations, and many Postgres functions are unsupported. Large aggregates can also require substantial memory.

**Strict synchronization across independent queries.** Separate subscriptions do not share a client-visible transaction marker or a read-after-write barrier. If correctness depends on coordinating several results at one database version, evaluate that requirement separately.

## Evaluate with one real screen

Choose a screen that would benefit from live data and use its actual query. Verify the first result, edit related rows, and test a reconnect. Then measure its memory use and database load with representative data and parameter values.

[Your first live query](/docs/quickstart/) covers the first part. [Add live data to your app](/docs/your-app/) covers the integration, and [memory and performance](/docs/performance/) covers workload evaluation.
