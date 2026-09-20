---
title: Introduction
description: Keep SQL query results up to date as your Postgres data changes.
section: Start here
order: 1
---

Walter keeps the results of SQL queries up to date as data changes in Postgres. Your server subscribes to a query and receives its current result, followed by updates when that result changes.

For example, a task list can subscribe to the twenty most recent unfinished tasks. When someone edits a title, the title changes in the list. When they complete a task, it leaves the list. If there are more unfinished tasks, another one takes its place.

Your app still writes to Postgres through its existing API, ORM, or database driver. Walter reads committed changes using **logical replication**, a Postgres feature that lets another process follow changes to tables.

## What you add to your app

Walter runs as a service alongside Postgres and your application server. There are three parts to an integration:

1. **The engine** connects to Postgres and maintains query results.
2. **Your server** checks who is making a request, chooses the SQL and its parameters, and subscribes to the engine.
3. **Your app** receives the result through your server and displays it.

In a JavaScript app, `@walter-sql/client` provides the server's connection to the engine. `@walter-sql/view` applies incoming updates to an array of rows in the browser. You choose how messages travel between your server and the browser; the docs include oRPC and server-sent event examples.

Keep the engine accessible only to trusted servers. It has no concept of your application's users or their permissions.

## What a subscription sends

The first successful response is a **snapshot**: the complete result of your query, as JSON rows. Later messages usually contain a **diff**: instructions to add, remove, edit, or reorder rows. The client helpers apply those instructions for you.

A subscription can receive another snapshot after a restart or a connection interruption. It replaces the previous result. You do not need to keep a history of changes to recover.

Walter also supports joins, aggregates, and nested results. A project with its tasks, or a task with its comments, can be returned by one query. The [query guides](/docs/writing-shapes/) introduce these features with examples.

## Before you start

You need a Postgres primary with logical replication enabled and a server that can keep a connection open to Walter. You can run the engine in Docker or with Node.js. Startup creates or updates a Postgres publication and configures the tables it serves. [Installation](/docs/installation/) covers the database requirements, optional table scoping, and startup methods.

Walter supports a defined set of `SELECT` queries. Some valid Postgres queries cannot be used as subscriptions, including window functions and recursive queries. Check [SQL support](/docs/sql-support/) for a query you already use, and [Postgres differences](/docs/deviations/) for value and comparison behavior.

Walter stores active query state in memory. After an engine restart, it reads the data again. It does not provide offline writes, an on-device database, or a durable history of events. [When to use Walter](/docs/comparison/) discusses those tradeoffs.

## Get a query running

Start with [Installation](/docs/installation/), then [Your first live query](/docs/quickstart/). Both use your existing database. If Walter is already running, go directly to [Add live data to your app](/docs/your-app/).
