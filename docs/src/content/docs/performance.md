---
title: Memory and performance
description: Understand what a query retains, how updates create work, and how to measure your application's workload.
section: Operations
order: 3
---

Walter maintains subscribed query results in memory and shares work when subscriptions use the same query and parameters. Capacity depends on the queries, their input data, the rate of database changes, and the number of consumers.

Measure those factors with a representative application workload. A count of subscribers by itself does not describe the work the engine needs to do.

## What uses memory

A maintained query can hold source rows, intermediate join or aggregate state, and the rows in its result. The source rows may contain more columns than the query returns. A relay also keeps the current result so it can provide a snapshot to a new subscriber.

Different parameter values create different maintained results. A thousand people viewing one shared task list can reuse query maintenance. A thousand private task lists can require a thousand different results. Queries that overlap can retain separate copies of the same source rows.

When the last subscriber leaves, the engine retains that result for `WALTER_GRACE_TTL_MS`, thirty seconds by default. This avoids rebuilding a result for a brief disconnect or navigation away and back. Lowering the grace period releases idle results sooner but can increase the frequency of new reads.

## A limit does not always bound memory

For suitable ordered queries, Walter fetches a bounded set of rows and refills it as rows leave the result. For example:

```sql
SELECT id, title, done
FROM tasks
WHERE project_id = $1 AND NOT done
ORDER BY id DESC
LIMIT 20
```

The engine keeps extra rows beyond the visible limit to support refilling. An offset increases how many rows are needed before the visible page.

Some queries cannot use that optimization. Examples include ordering by an expression or an aggregate, and queries with `DISTINCT`, `HAVING`, or an `EXISTS` filter. They may need all matching source rows even though the output has a limit.

Joins and aggregates can also need substantial related data. A query returning the ten projects with the most comments needs the counts used to rank those projects. Ten output rows do not imply ten source rows.

`walter_working_set_rows` helps track retained source rows. Use process memory alongside it because operator state, materialized results, and outgoing buffers also take space.

## What creates processing work

Walter updates maintained results from database changes. The cost depends on how those changes affect the query:

- Renaming a user can update every visible row that contains that user's name.
- Removing a row from an ordered list can require reading its replacement from Postgres.
- A join can turn one input change into changes to many result rows.
- Many distinct queries using a table may all need to process a change to it.

The engine sends diffs when the result changes. Those diffs can be smaller than sending the whole result, but their size depends on the actual change. There is no fixed per-change cost.

## Account for Postgres work

Walter reads rows when a query is first subscribed to, when more related data is needed, and when a result rebuilds after recovery. Suitable indexes on filters, join columns, and ordering columns can help those reads. Use your database's query and index tools to investigate slow reads for your workload.

Every owner in a cluster receives its own stream of changes for the publication. Adding owners distributes query maintenance, and also adds replication and decoding work on Postgres. Relay-only nodes do not open database connections. [Scaling](/docs/scaling/) explains how to combine the two roles.

## Slow consumers

There are queues between replication, query processing, and network consumers. Walter applies backpressure to the replication pipeline when processing falls behind. It can combine queued commits while updating a result.

If an engine connection's outgoing queue overflows, the engine closes the socket with code `1013`. `EngineClient` reconnects and receives fresh snapshots. The client's async stream also resets its subscription if its message backlog overflows.

Your browser transport has its own buffering behavior. Handle slow readers there as well; an engine queue limit does not bound a separate HTTP or WebSocket buffer in your application server.

## Measure a representative workload

Use your actual queries and data distribution. Include both popular shared results and personalized queries with different parameters.

Observe process memory, retained source rows, processing backlog, outgoing buffers, and time to receive an initial snapshot. Measure application-visible update latency separately; the replication activity metric includes heartbeats and is not end-to-end latency.

Exercise the changes your application makes, including updates to widely referenced rows and write bursts on queries with limits or joins. Then restart an engine to measure the cost of rebuilding its active subscriptions. These observations help decide whether to adjust queries, database indexes, instance resources, or the [number of owners and relays](/docs/scaling/).
