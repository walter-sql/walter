---
title: Joins and nested results
description: Return related rows as columns, objects, or arrays, with examples of the resulting JSON.
section: Build your app
order: 4
---

A query can return related data in the form your screen needs. Use a join for additional columns, a JSON object for one related row, and a JSON aggregate for a collection of related rows.

These examples build on a task list. They assume the following columns:

| Table      | Columns used here                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`    | `id` (integer primary key), `project_id` (integer), `assignee_id` (integer, nullable), `title` (text), `done` (boolean), `created_at` (timestamptz) |
| `users`    | `id` (integer primary key), `name` (text)                                                                                                           |
| `comments` | `id` (integer primary key), `task_id` (integer), `author_id` (integer), `body` (text), `created_at` (timestamptz)                                   |

Adapt the names and types to your schema. If you restrict Walter to a table list, include all referenced tables. Follow the [migration steps](/docs/operations/#schema-migrations) after changing the schema or table list.

## Add a column from another table

A task list can include the assignee's name:

```sql
SELECT t.id, t.title, u.name AS assignee
FROM tasks t
LEFT JOIN users u ON u.id = t.assignee_id
WHERE t.project_id = $1 AND NOT t.done
ORDER BY t.id DESC
LIMIT 20
```

For `params: [7]`, part of the result might be:

```json
[
  { "id": 42, "title": "Review the migration", "assignee": "Maya" },
  { "id": 41, "title": "Update the changelog", "assignee": null }
]
```

`LEFT JOIN` keeps tasks with no matching user. Use `INNER JOIN` if you want those tasks excluded. Editing a user's name updates the tasks that show that name.

Joins need a column-equality condition such as `u.id = t.assignee_id`. Additional conditions are supported, but joins based only on ranges or inequalities are not. See [SQL support](/docs/sql-support/#joins).

## Return a related object

Use `json_build_object` when the UI needs more than one field from the assignee:

```sql
SELECT t.id, t.title, t.assignee_id AS "assigneeId",
       json_build_object('id', u.id, 'name', u.name) AS assignee
FROM tasks t
LEFT JOIN users u ON u.id = t.assignee_id
WHERE t.project_id = $1 AND NOT t.done
ORDER BY t.id DESC
LIMIT 20
```

The result now contains an object:

```json
[
  {
    "id": 42,
    "title": "Review the migration",
    "assigneeId": 3,
    "assignee": { "id": 3, "name": "Maya" }
  },
  {
    "id": 41,
    "title": "Update the changelog",
    "assigneeId": null,
    "assignee": null
  }
]
```

The selected `assigneeId` is the task's link to its user. Include the parent column used to connect a nested relation; Walter needs it in the parent result to attach the child. Without it, an inline JSON object can remain a plain object value instead of becoming a nested relation.

Because `users.id` is a primary key, Walter knows there can be at most one assignee. It treats this as a **to-one relation**: one object when a match exists, or `null` when it does not. It can update fields inside that object.

That missing-object behavior is part of Walter's nested-result format. A raw `json_build_object` over a missing joined row in Postgres can instead produce an object containing null fields. See [Postgres differences](/docs/deviations/#nested-results).

## Return a collection

A task detail screen can request its comments in the same query:

```sql
SELECT t.id, t.title,
       (
         SELECT coalesce(
           json_agg(
             json_build_object('id', c.id, 'body', c.body)
             ORDER BY c.id
           ),
           '[]'
         )
         FROM comments c
         WHERE c.task_id = t.id
       ) AS comments
FROM tasks t
WHERE t.id = $1
```

For `params: [42]`, an example result is:

```json
[
  {
    "id": 42,
    "title": "Review the migration",
    "comments": [
      { "id": 101, "body": "Ready for review." },
      { "id": 102, "body": "I will take a look." }
    ]
  }
]
```

The outer query selects the task. `c.task_id = t.id` selects that task's comments. `json_build_object` defines a comment's fields, and `json_agg` collects the comments into an array. `ORDER BY c.id` orders that array independently of the outer query.

A task with no comments has `comments: []`. The outer result is still an array: if task 42 does not exist, the result is `[]`.

## Limit each collection

To fetch a task with its ten most recent comments, put the comment limit inside its subquery:

```sql
SELECT t.id, t.title,
       (
         SELECT coalesce(
           json_agg(
             json_build_object('id', c.id, 'body', c.body)
             ORDER BY c.created_at DESC, c.id DESC
           ),
           '[]'
         )
         FROM (
           SELECT id, body, created_at
           FROM comments
           WHERE task_id = t.id
           ORDER BY created_at DESC, id DESC
           LIMIT 10
         ) c
       ) AS comments
FROM tasks t
WHERE t.project_id = $1
ORDER BY t.id DESC
LIMIT 20
```

This returns up to twenty tasks, each with up to ten comments. The inner limit applies separately to each task. A new comment can enter its task's list and move the oldest visible comment out.

Nesting can continue to more levels, and a child query can contain supported joins. Start with the result you need and add one relation at a time; this makes it easier to check the SQL and the resulting JSON.

## Return the latest related row

A scalar JSON subquery with `LIMIT 1` can return the latest comment as one object:

```sql
SELECT t.id, t.title,
       (
         SELECT json_build_object('id', c.id, 'body', c.body)
         FROM comments c
         WHERE c.task_id = t.id
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 1
       ) AS "latestComment"
FROM tasks t
WHERE t.id = $1
```

`latestComment` is an object or `null`. The limit establishes that at most one row can match. Without a limit or a suitable unique key, Walter rejects a scalar nested object that could return several rows.

## Count related rows

Use an aggregate when you need a count rather than the comments themselves:

```sql
SELECT t.id, t.title, count(c.id) AS "commentCount"
FROM tasks t
LEFT JOIN comments c ON c.task_id = t.id
WHERE t.project_id = $1
GROUP BY t.id, t.title
ORDER BY t.id DESC
LIMIT 20
```

`count(c.id)` is zero for a task with no comments. Its JSON value is a string, such as `"0"` or `"12"`, because Postgres returns a `bigint` for `count`. Use `commentCount: string` in the row type.

## Receiving nested changes

Use `materialize`, `applyView`, or the TanStack Query helpers to apply updates. They handle nested objects and arrays as well as the outer rows. A change to a comment can update its field within the existing task result; you do not need to refetch the task yourself.

Raw message examples are in the [wire protocol](/docs/wire-protocol/). For how rows enter and leave a limited result, continue with [ordering and pagination](/docs/ordering/).
