---
title: Your first live query
description: Subscribe to a query on your own database and see its result change as you edit data.
section: Start here
order: 3
---

Use a query from your application for this walkthrough. You will subscribe from a small Node.js script, see the current rows, and then change one of them through your usual application or SQL client.

Walter should already be running against your database. If it is not, follow [Installation](/docs/installation/) first.

## Pick a query

Start with a query that selects a few columns from one table. For example, an app with a `tasks` table might use:

```sql
SELECT id, title, done
FROM tasks
WHERE NOT done
ORDER BY id DESC
LIMIT 20
```

This example assumes `id` is an integer primary key, `title` is text, and `done` is a boolean. Replace it with a query against your schema. Select the primary key along with the fields you want to display. If you restricted Walter to a list of tables, include this table in that list.

Run the query in your SQL client first so you know which rows to expect. An empty result is valid.

## Subscribe from Node.js

With Node.js 22 or newer, install the client in your application's server directory:

```bash
npm install @walter-sql/client
```

Save the following as `live.mjs`. Use the same SQL you chose above.

```js
import { EngineClient, materialize } from "@walter-sql/client";

const walter = new EngineClient(
  process.env.WALTER_URL ?? "ws://127.0.0.1:5544",
  { secret: process.env.WALTER_SECRET }
);

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
node live.mjs
```

The first output is the query's current result. `materialize` builds the array of rows from the messages Walter sends; your loop does not need to apply changes itself.

This script is a server-side consumer. In a browser app, your application server owns `EngineClient` and passes the messages to the browser. The [next guide](/docs/your-app/) explains that connection.

## Change a row

Leave the script running. In your app or SQL client, edit a row that appears in the result and commit the change.

For the task example, choose an actual task ID. If that ID is `42`, these statements illustrate two separate changes:

```sql
UPDATE tasks SET title = 'Review the migration' WHERE id = 42;
```

The script prints the result with the new title. Then complete the task:

```sql
UPDATE tasks SET done = true WHERE id = 42;
```

The task leaves the result because it no longer matches `WHERE NOT done`. If there are other unfinished tasks beyond the first twenty, the next one enters the list.

If your SQL client has autocommit disabled, commit each statement to see each change separately. Walter follows committed data. A change that does not affect your query's result produces no output for that subscription, and several commits may be combined into one update.

Press Ctrl+C to end the subscription and close the script.

## If the result does not appear

| What you see                  | What to check                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No first output               | Before Postgres first connects, subscriptions wait without error. Check `/ready`, the engine log, `WALTER_URL`, and, if configured, `WALTER_SECRET`. |
| A table or column error       | Check the SQL, the table list, and the schema name. Restart Walter after schema changes.                                                             |
| `unsupported_sql`             | Start with a single-table query and check [SQL support](/docs/sql-support/). A query can work in Postgres and still be unsupported by Walter.        |
| `failed`                      | The engine could not build or update this result. Read its log for the cause; it will retry.                                                         |
| Rows appear but do not change | Commit the write, confirm that it affects this query, then check replication readiness.                                                              |

Once this works, [add the subscription to your app](/docs/your-app/). To try a complete application without adapting your own schema, the repository also includes an [auction demo](https://github.com/walter-sql/walter/tree/master/examples/demo).
