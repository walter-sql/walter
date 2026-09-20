---
title: How Walter works
description: Follow a query from its first result through database changes, nested updates, and recovery.
section: Background
order: 1
---

Consider a screen showing unfinished tasks and their comments. The screen needs an initial result, then updates when someone edits a task, completes it, or adds a comment.

Walter maintains that query's result in memory. This page follows what happens from the first subscription onward. You can use Walter without knowing the implementation details, but they help explain its database load and recovery behavior.

## Reading the first result

Your server sends SQL and parameter values to the engine. Walter parses the SQL and checks it against the table and column information it loaded from Postgres at startup.

If the query is supported, Walter builds a plan for maintaining it. It fetches the source rows the plan needs from Postgres and assembles the result. Your server receives that result as a snapshot.

The initial read may involve several database queries, especially for joins, nested collections, or limited lists. Even then, the snapshot reflects one consistent moment in the database. Walter does not load a complete copy of the database before accepting subscriptions.

## Following database changes

Postgres records committed changes in its write-ahead log, usually called the WAL. Logical replication makes table changes from that log available to Walter.

When a transaction commits, Walter passes its changes to the queries that use those tables. It updates their maintained results and sends diffs for results that changed. Several commits can be processed together when a query is catching up.

The writer does not need to notify Walter. A change made through your API, a background job, or a SQL client follows the same route after it commits.

## Updating a result incrementally

Suppose a query counts the comments on a task. When a comment is inserted, Walter updates the count it already holds. It does not need to rerun the whole count query for every insertion.

This is **incremental view maintenance**: computing how an existing query result changes from changes to its input rows. Walter uses operators for filtering, joining, grouping, and ordering to do this work.

The amount of work depends on the query. Editing a shared user's name may affect many tasks. Removing a row from a limited list can require fetching a replacement. Incremental maintenance reduces repeated work, but a small database change does not always mean a small amount of processing.

## Handling nested results

A task and its comments have separate result lists inside the engine. The condition `comments.task_id = tasks.id` tells Walter which comment list belongs to each task.

When a comment's body changes, Walter can send an update for that comment inside the task's `comments` array. Your app's view helper applies it in place within the result structure. If the comment no longer matches the query, it is removed instead.

Each nested list has its own filter, order, and limit. “Twenty tasks with ten comments each” therefore has a limit for the tasks and a separate limit for every task's comments.

## Keeping the rows a query needs

Walter may need source rows that are not visible in the final response. A join needs matching rows from another table; an aggregate needs the rows contributing to its value. Some ordered queries retain extra rows to refill the visible list.

When a new relationship needs rows the engine has not loaded, it fetches them from Postgres. Database reads record which transactions they include, so the engine can avoid applying those same changes again when they arrive through replication.

The stored data depends on active queries, including their source rows and intermediate results. It can still be large. [Memory and performance](/docs/performance/) explains which query choices affect it.

## Sharing a subscription

On one engine, subscriptions with the same parsed query and parameters reuse maintained state. Each subscriber receives the result through its own subscription. This reduces duplicate query maintenance for screens watching the same data.

After the last subscriber leaves, the result stays available for a grace period, thirty seconds by default. A subscriber returning during that time can reuse it. After the grace period, the engine discards the query's state.

Different parameter values produce different results to maintain. Similar queries are not guaranteed to share state, and cluster routing uses the SQL text and parameter values. These distinctions matter when estimating memory use.

## Recovering without saved query state

Walter keeps query state in memory and uses a temporary replication slot. An engine restart loses that state. Active clients reconnect, resubscribe, and receive new snapshots.

If only the replication connection drops, the engine reconnects to Postgres and rebuilds its existing results. Subscribers can retain their last rows while that happens. There is no replay cursor for the application to save.

This makes recovery depend on fresh reads from Postgres. The practical details, including status indicators and schema migrations, are in [recovery and monitoring](/docs/operations/).
