![Walter - live SQL queries for Postgres](assets/banner.svg)

Walter keeps SQL query results up to date as data changes in Postgres. Your application server subscribes to a query and receives its current rows, followed by updates when the result changes.

Queries can include joins, aggregates, ordering, limits, and nested JSON results. See [SQL support](https://walter.ax/docs/sql-support/) for the queries and functions it supports.

## Start Walter

Use an existing Postgres primary with logical replication enabled. The [installation guide](https://walter.ax/docs/installation/) covers database permissions and what Walter sets up automatically.

Create `walter.env` with your connection string. Walter uses all tables by default; uncomment the last line to choose a subset.

```dotenv
WALTER_PG=postgres://USER:PASSWORD@DATABASE_HOST:5432/DATABASE

# Optional: uncomment to restrict Walter to these tables.
# WALTER_TABLES=public.tasks,public.users
```

```sh
docker run -d --name walter \
  --env-file walter.env \
  -p 127.0.0.1:5544:5544 \
  ghcr.io/walter-sql/engine:latest
```

`DATABASE_HOST` must be reachable from the container; `localhost` refers to the container itself. The installation guide also includes [Docker Compose](https://walter.ax/docs/installation/#docker-compose) and [Node.js](https://walter.ax/docs/installation/#nodejs) alternatives. See [Configuration](https://walter.ax/docs/configuration/) for authentication and other settings.

## A live query

Install the client in your application server project (Node.js 22+):

```sh
npm install @walter-sql/client
```

For an app with a `tasks` table, this subscription follows the twenty most recent unfinished tasks in a project. Adapt the table, columns, and project ID to your schema.

```js
import { EngineClient, materialize } from "@walter-sql/client";

const walter = new EngineClient("ws://127.0.0.1:5544");

const stream = walter.stream({
  sql: `SELECT id, title
        FROM tasks
        WHERE project_id = $1 AND NOT done
        ORDER BY id DESC
        LIMIT 20`,
  params: [42]
});

for await (const { rows } of materialize(stream)) {
  console.table(rows);
}
```

Edit a task's title and the result updates. Complete a task and it leaves the list; the next unfinished task takes its place if there is one. Walter sends changes to the result, and `materialize` applies them to the array of rows.

## Where it fits

Walter runs alongside Postgres and your application server. It reads committed changes through logical replication, so writes from your API, background workers, and SQL clients are all observed.

Your server authenticates users, chooses their SQL and parameters, and passes the updates to the app. Keep the engine accessible to trusted servers. Your app can keep its existing ORM and write API, and you choose the transport between server and browser. The [app integration guide](https://walter.ax/docs/your-app/) explains the connection and client helpers.

Active query state is held in memory and rebuilt from Postgres after a restart. Query processing and delivery to subscribers can be distributed across instances; the [scaling guide](https://walter.ax/docs/scaling/) explains the deployment options.

## Documentation and examples

Follow [Your first live query](https://walter.ax/docs/quickstart/) for a walkthrough using your own database and query.

For a complete integration, [the auction demo](examples/demo) includes a Postgres database, Walter, an authenticated oRPC server, and a React app using TanStack Query. The [documentation](https://walter.ax/docs/) covers query design, deployment, recovery, and the protocol.

## License

[Apache 2.0](LICENSE)
