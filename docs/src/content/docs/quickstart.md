---
title: Your first live query
description: Run a small Node.js script, see the current rows, and watch the result change when you edit a task.
section: Start here
order: 4
---

You need Node.js 22 or newer and Walter connected to a development database. [Installation](/docs/installation/) covers engine setup. Use your own table, or create the example below.

## Pick a query

The examples use a `tasks` table. If your database already has one, adapt the query to its columns.

<details>
<summary>Create the example table</summary>

Run this in a development database without an existing `tasks` table:

```sql
CREATE TABLE tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id integer NOT NULL DEFAULT 1,
  assignee_id integer NOT NULL DEFAULT 7,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

INSERT INTO tasks (title) VALUES
  ('Review the migration'),
  ('Update the changelog'),
  ('Fix the notification count');
```

If Walter is already running, restart it so it reads the new schema. If you set `WALTER_TABLES`, include `public.tasks`. The `project_id` and `assignee_id` columns are used in later guides.

</details>

Subscribe to the twenty most recent unfinished tasks:

```sql
SELECT id, title, done
FROM tasks
WHERE NOT done
ORDER BY id DESC
LIMIT 20
```

Run this query in your SQL client first. With the example data, expect three rows ordered by descending ID. An empty result from your own table is also valid.

## Subscribe from Node.js

Install the client in your application's server directory:

```bash
npm install @walter-sql/client
```

Save the following as `live.js`. Use the same SQL you chose above.

```js
import { EngineClient, materialize } from "@walter-sql/client";

const walter = new EngineClient("ws://127.0.0.1:5544");

const stream = walter.stream({
  sql: `SELECT id, title, done
        FROM tasks
        WHERE NOT done
        ORDER BY id DESC
        LIMIT 20`
});

for await (const { rows, status } of materialize(stream)) {
  console.log(status);
  console.table(rows);
}
```

Run it:

```bash
node live.js
```

The first output is the query's current result. `materialize` builds the array of rows from the messages Walter sends; your loop does not need to apply changes itself.

This script is a server-side consumer. In a browser app, your application server owns `EngineClient` and passes the messages to the browser. The [next guide](/docs/your-app/) explains that connection.

## Change a row

Leave the script running. In your app or SQL client, edit a row that appears in the result and commit the change.

With the example data, task `2` is “Update the changelog.” For your own data, substitute an ID from the result:

```sql
UPDATE tasks SET title = 'Publish the changelog' WHERE id = 2;
```

The script prints the result with the new title. Then complete the task:

```sql
UPDATE tasks SET done = true WHERE id = 2;
```

The task leaves the result because it no longer matches `WHERE NOT done`. If there are other unfinished tasks beyond the first twenty, the next one enters the list.

If your SQL client has autocommit disabled, commit each statement to see each change separately. Walter follows committed data. A change that does not affect your query's result produces no output for that subscription, and several commits may be combined into one update.

Press Ctrl+C to end the subscription and close the script.

## If the result does not appear

| What you see                  | What to check                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No first output               | Before Postgres first connects, subscriptions wait without error. Check `/ready`, the engine log, and the URL passed to `EngineClient`.       |
| A table or column error       | Check the SQL, the table list, and the schema name. Restart Walter after schema changes.                                                      |
| `unsupported_sql`             | Start with a single-table query and check [SQL support](/docs/sql-support/). A query can work in Postgres and still be unsupported by Walter. |
| `failed`                      | The engine could not build or update this result. Read its log for the cause; it will retry.                                                  |
| Rows appear but do not change | Commit the write, confirm that it affects this query, then check replication readiness.                                                       |

Once this works, [add the subscription to your app](/docs/your-app/). To try a complete application without adapting your own schema, the repository also includes an [auction demo](https://github.com/walter-sql/walter/tree/master/examples/demo).
