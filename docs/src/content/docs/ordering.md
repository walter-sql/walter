---
title: Ordering and pagination
description: Keep ordered lists live, choose a stable order, and understand what happens as rows move between pages.
section: Build your app
order: 5
---

A live result can change both its contents and its order. If your query asks for the twenty latest tasks, a new task can enter at the top and push another task out of the result.

## Choose a stable order

Specify `ORDER BY` when the display order matters. Include a unique field to break ties:

```sql
SELECT id, title, done, created_at AS "createdAt"
FROM tasks
WHERE project_id = $1 AND NOT done
ORDER BY created_at DESC, id DESC
LIMIT 20
```

Here two tasks with the same timestamp are ordered by ID. Without an explicit order, do not rely on the order in which rows happen to arrive.

An update to an ordering field can move a row. The view helpers apply both field changes and reordering, so render the resulting `rows` array in its given order. Do not use the diff's array indices as permanent row IDs.

## Understand a live limit

`LIMIT 20` means at most twenty rows in the current result. It does not mean “send twenty rows once, then append all future rows.”

If a task is completed, it stops matching `WHERE NOT done`. Walter removes it and, if possible, fills its place with the next matching task. The same applies to per-parent limits in [nested collections](/docs/relations/#limit-each-collection).

A limit bounds the response size. It does not always bound the amount of data Walter needs in memory. Queries that sort by aggregate values or expressions, for example, can need many more input rows. See [memory and performance](/docs/performance/#a-limit-does-not-always-bound-memory).

## Change the page size

A limit can be a parameter:

```sql
SELECT id, title, done
FROM tasks
WHERE project_id = $1
ORDER BY id DESC
LIMIT $2
```

To change from twenty to fifty rows, end the existing subscription and open one with `params: [projectId, 50]`. The new stream starts with a snapshot of the new result.

This can be a useful approach to “load more”: one subscription represents all currently displayed rows. Its result and memory cost grow with the limit.

## Cursor-based pages

For an ID ordered list, a subsequent page can use the last visible ID as a bound:

```sql
SELECT id, title, done
FROM tasks
WHERE project_id = $1 AND id < $2
ORDER BY id DESC
LIMIT 20
```

Use the first-page query without the cursor condition for the first page. Each later page is a separate subscription with a fixed cursor value. Walter does not maintain or advance that cursor for you.

For a timestamp order, include both the timestamp and the tie-breaking ID in the condition:

```sql
SELECT id, title, done, created_at AS "createdAt"
FROM tasks
WHERE project_id = $1
  AND (
    created_at < $2::timestamptz
    OR (created_at = $2::timestamptz AND id < $3)
  )
ORDER BY created_at DESC, id DESC
LIMIT 20
```

Preserve the timestamp text from the result when using it as a cursor. Converting it through a JavaScript `Date` loses sub-millisecond precision.

## Decide how pages should move

Separate live pages can overlap or leave gaps as rows are inserted, removed, or reordered. For example, a first page can refill past a previously chosen cursor after deletions, while the next page still starts at that old cursor.

Choose a behavior for your UI: enlarge one live result, keep only the current page live, or manage page boundaries and deduplication in your application. Independent subscriptions do not provide a shared frozen snapshot across pages.

`OFFSET` is supported too, but positions move as data changes. Increasing an offset can also increase the number of rows the engine must retain, even when the returned page size is unchanged.
