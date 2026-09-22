---
title: Installation
description: Connect Walter to your Postgres database using Docker, Docker Compose, or Node.js.
section: Start here
order: 2
---

Walter connects to an existing Postgres primary. By default, it follows changes to all tables in that database. You can restrict it to specific tables with `WALTER_TABLES`.

Start with a development or staging database where you can try queries and change data. The database setup below applies to [Docker](#docker), [Docker Compose](#docker-compose), and [Node.js](#nodejs).

## Prepare Postgres

The minimum supported Postgres version is 14. Using your usual SQL client, check the replication settings:

```sql
SHOW wal_level;
SHOW max_replication_slots;
SHOW max_wal_senders;
```

`wal_level` must be `logical`. If it is not, change the setting in your Postgres configuration or your provider's dashboard and restart Postgres as required by the provider.

Each Walter instance connected to Postgres uses one logical replication slot and one replication sender connection. Leave capacity for any replicas or other replication clients you already run. See [Postgres's replication configuration documentation](https://www.postgresql.org/docs/18/logical-replication-config.html).

Use a database endpoint that supports logical replication. A connection pooler's transaction endpoint cannot replace that connection; check the endpoint your database provider supplies for replication.

## Configure the connection

For Docker or Compose, create a file named `walter.env` with your connection string:

```dotenv
WALTER_PG=postgres://USER:PASSWORD@DATABASE_HOST:5432/DATABASE

# Optional: uncomment to restrict Walter to these tables.
# WALTER_TABLES=public.tasks,public.users
```

Uncomment the last line and replace the table names if you want to choose a subset. Include any tables used by joins or nested queries. Leaving the line commented uses all tables.

Use a database hostname reachable from the container. `localhost` inside a container refers to that container. If Postgres is in the same Compose project, use its service name as the database host. Include any TLS settings required by your database provider in the connection string.

## What Walter sets up automatically

On startup, Walter:

- Creates or updates a publication named `walter_pub`. A publication tells Postgres which tables' changes to make available through replication. It includes all tables by default, or the tables in `WALTER_TABLES` when you provide a list.
- Sets `REPLICA IDENTITY FULL` on those tables if it is not already set. This includes old row values in updates and deletes, which Walter needs to maintain results.
- Reads table names, columns, types, primary keys, and unique keys to check subscription queries.

Changing replica identity requires a table lock and can increase the amount of WAL produced by updates and deletes. Plan the first setup of busy tables accordingly. See the [Postgres replica identity reference](https://www.postgresql.org/docs/18/sql-altertable.html#SQL-ALTERTABLE-REPLICA-IDENTITY).

Walter creates no application tables and requires no extensions or triggers. The publication and replica identity settings remain after the engine stops. Its replication slot is temporary and is removed when the replication connection ends.

### Database permissions

The connection role needs permission to connect to the database, use the relevant schemas, read the served tables, and stream logical replication.

The role must also be allowed to call `pg_logical_emit_message`, which Walter uses to keep results consistent. This writes replication messages without changing application rows.

Automatic setup also needs the rights to create or modify `walter_pub` and alter the served tables. Creating the default all-table publication requires a Postgres superuser. Creating a publication for an explicit table list requires `CREATE` on the database and ownership rights on those tables. [Postgres documents these publication permissions](https://www.postgresql.org/docs/18/sql-createpublication.html#SQL-CREATEPUBLICATION-NOTES).

An administrator can prepare the publication and replica identity settings ahead of time so the runtime role does not need to change them. They must match the default all-table mode or your chosen table list. On Postgres 18, the publication must also use `publish_generated_columns = stored`. Managed services may provide replication privileges through a provider-specific role.

Walter expects complete changes for the tables it serves. Do not add publication row filters, column lists, or custom publication options. Per-user access belongs in [your application's authorization logic](/docs/access-control/).

## Start the engine

Choose one of the following methods. Docker and Compose read the same `walter.env` file.

### Docker

```bash
docker run -d --name walter \
  --env-file walter.env \
  -p 127.0.0.1:5544:5544 \
  ghcr.io/walter-sql/engine:latest
```

The image includes the engine and its Node.js runtime, runs as a non-root user, and listens on `0.0.0.0` inside the container. This command publishes the port on your machine's loopback interface, at `ws://127.0.0.1:5544`.

### Docker Compose

Add this service to your Compose file, with `walter.env` alongside it:

```yaml
services:
  walter:
    image: ghcr.io/walter-sql/engine:latest
    restart: unless-stopped
    env_file:
      - path: walter.env
        format: raw
    ports:
      - "127.0.0.1:5544:5544"
```

```bash
docker compose up -d walter
```

The `raw` format preserves literal values, including `$` characters, as `docker run --env-file` does. It requires [Compose 2.30 or newer](https://docs.docker.com/reference/compose-file/services/#format).

An application server in the same Compose project connects to `ws://walter:5544`. `docker compose up --wait walter` and `depends_on` with `condition: service_healthy` wait for `/live`, which checks the engine process. Use `/ready` to check its Postgres connection. You can omit `ports` when no connections from the host are needed. If you are switching from the Docker command above, stop that container first to free the host port.

Both Docker examples use `:latest`. Pin a tested image tag or digest in production. Walter needs no persistent volume for query state; it rebuilds active results from Postgres after a restart.

### Node.js

To run without Docker, use Node.js 22 or newer:

```bash
WALTER_PG='postgres://USER:PASSWORD@HOST:5432/DATABASE' \
npx @walter-sql/engine
```

The CLI reads its process environment; it does not load `walter.env` itself. Set any optional variables, including `WALTER_TABLES` if you chose a subset, in that environment too. For a deployment, install and pin the package version you have tested.

To embed the engine in an existing Node.js process, see the [programmatic API](/docs/configuration/#programmatic-api).

## Check the connection

```bash
curl --fail http://127.0.0.1:5544/ready
```

`/ready` returns 200 with no body once the replication slot exists. While it returns 503, Walter stays up and retries every second. Check `docker logs walter` or `docker compose logs walter` for the cause. Walter recovers without a restart once it is fixed.

Once the engine is ready, continue with [Your first live query](/docs/quickstart/). The [Configuration reference](/docs/configuration/) covers authentication, networking, optional settings, and how to apply changes.

## Generated columns and partitions

Stored generated columns are available to subscriptions on Postgres 18, where Walter configures their publication. On earlier versions, they are not part of the columns Walter can serve. A published table with virtual generated columns prevents readiness because those columns cannot be delivered through logical replication. You can use `WALTER_TABLES` to exclude such tables.

Partitioned tables are exposed through the published leaf partitions. Do not assume that querying a partitioned parent is interchangeable with querying those leaves in Walter. A publication using `publish_via_partition_root = true` is rejected. Verify the published relation names and test the queries you intend to use when evaluating a partitioned schema.

## Build the image yourself

From the repository root:

```bash
docker build -f packages/engine/Dockerfile -t walter-engine .
```

Use `walter-engine` in place of the GHCR image name in either Docker example.
