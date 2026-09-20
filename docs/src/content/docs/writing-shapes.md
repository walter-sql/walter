---
title: Queries and parameters
description: Write a subscription query, bind values, choose result columns, and understand how subscriptions are shared.
section: Build your app
order: 3
---

A Walter subscription is defined by one `SELECT` statement and its parameter values. The API calls this pair a **shape**. There is no separate schema or subscription language to define.

Begin with the data a screen needs: which rows, which fields, and which order. For example:

```sql
SELECT id, title, done
FROM tasks
WHERE project_id = $1 AND NOT done
ORDER BY id DESC
LIMIT 20
```

This returns up to twenty unfinished tasks in one project. Inserts, edits, and deletes can change the list. Marking a task as done removes it because it no longer matches the filter.

## Bind values with parameters

Use `$1`, `$2`, and so on for values supplied by the server:

```ts
const shape = {
  sql: `SELECT id, title, done
        FROM tasks
        WHERE project_id = $1 AND NOT done
        ORDER BY id DESC
        LIMIT $2`,
  params: [projectId, 20]
};
```

The first array value supplies `$1`. Do not interpolate values into SQL strings. Table names, column names, and sort directions are SQL syntax rather than parameters; choose those from server-controlled query definitions.

For a list of IDs, pass an array as one parameter:

```sql
SELECT id, title, done
FROM tasks
WHERE id = ANY($1)
ORDER BY id
```

For example, `params: [[12, 34, 56]]` supplies three IDs. Include a value for every referenced parameter and no extra unused parameters.

## Declare a type when needed

Walter can usually determine a parameter's type from a column comparison. In `project_id = $1`, it uses the type of `project_id`.

Where the surrounding expression does not identify a type, annotate the parameter in SQL, such as `$1::int` or `$1::timestamptz`. For timestamp parameters, use an explicit offset:

```sql
SELECT id, title, done
FROM tasks
WHERE created_at >= $1::timestamptz
ORDER BY created_at DESC, id DESC
LIMIT 20
```

A matching value is `params: ["2026-09-01T00:00:00Z"]`. The cast declares the parameter's input type. It is not a general-purpose conversion of arbitrary JSON values. [Data types](/docs/types/) describes accepted representations.

## Choose fields and names

Use explicit columns to keep the API response clear. `SELECT *` is supported, but changes to the table can change the response after Walter restarts.

Include primary-key columns when they are useful to the application and to identifying result rows. Walter uses them where possible to represent an edit as a field update. Queries without a usable result key can still work, but changes may be represented as removals and additions. A primary key is not a universal requirement for every query.

Every output column needs a distinct name. Alias overlapping names in joins. Quote an alias when its case matters:

```sql
SELECT id, title, created_at AS "createdAt"
FROM tasks
WHERE project_id = $1
ORDER BY id DESC
LIMIT 20
```

The JSON rows have a `createdAt` field. Unquoted identifiers follow Postgres's usual lowercase rules.

## Change a subscription

SQL and parameters are fixed for the lifetime of a subscription. To switch projects, stop the old stream and open a new one with the new project ID. Its snapshot becomes the new result.

Subscribers to the same query and parameter values can share maintained state in the engine. Different users or projects often produce different parameter values and therefore different results to maintain. Do not assume that all queries mentioning the same table share one result. [Memory and performance](/docs/performance/) explains the cost.

## Use queries from an ORM

You can submit SQL and parameters produced by an ORM if that SQL falls within [Walter's supported SQL](/docs/sql-support/). The ORM's presence does not make every query it generates supported.

Walter recognizes several common forms of nested SQL, including correlated JSON subqueries and some lateral joins. Test the actual query your ORM emits. The next guide shows [joins and nested results](/docs/relations/) with SQL and the JSON they produce.
