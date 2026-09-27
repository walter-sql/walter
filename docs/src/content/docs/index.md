---
title: Introduction
description: Subscribe to a SQL query on your Postgres database. Walter sends its current result, then updates as that result changes.
section: Start here
order: 1
diagram: data-path
---

[Install Walter](/docs/installation/) to connect your database, then run [your first live query](/docs/quickstart/). If the engine is already running, go straight to [connecting your app](/docs/your-app/).

## What a live query does

Imagine a list of the twenty most recent unfinished tasks. An edited title updates in the list. A completed task leaves it, and the next unfinished task takes its place. The same query can include the assignee, comments, and counts from related tables.

Keep writing to Postgres through your existing APIs, ORM, database drivers, and background jobs. Walter uses **logical replication** to follow committed changes, regardless of how they were written.

## Where Walter runs

Walter runs alongside your database and application server:

- **The engine** maintains query results in memory.
- **Your server** authenticates callers and chooses the SQL and parameters they may use.
- **Your app** receives updates through your server's API.

Keep the engine on a trusted network. Your server owns user permissions and the connection to Walter. [Framework integrations](/docs/integrations/) show how to deliver updates through your existing stack.

## What a subscription sends

The first successful result is a **snapshot**: an array of JSON rows. Later **diffs** add, remove, edit, or reorder rows. Walter's client helpers apply these updates, including changes inside nested results.

If the engine restarts or your server loses its connection to it, the subscription resumes with a fresh snapshot once the connection recovers. That snapshot replaces the result your app was holding.

## Requirements

You need Postgres 14 or newer with logical replication, a trusted application server, and a supported `SELECT` query. Memory use depends on the data your active queries need.

[When to use Walter](/docs/comparison/) explains the tradeoffs. The [SQL reference](/docs/sql-support/) and [Postgres differences](/docs/deviations/) help you evaluate a specific query.
