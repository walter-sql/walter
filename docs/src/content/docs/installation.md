---
title: Installation
description: Connect Walter to your Postgres database using Docker, Docker Compose, or Node.js.
section: Start here
order: 3
---

Start with a development or staging Postgres primary. Prepare replication, review the database changes below, then choose [Docker](#docker), [Docker Compose](#docker-compose), or [Node.js](#nodejs).

## Prepare Postgres

Use Postgres 14 or newer. In your SQL client, check:

```sql
SHOW wal_level;
SHOW max_replication_slots;
SHOW max_wal_senders;
```

`wal_level` must be `logical`. If it is not, change the setting in your Postgres configuration or your provider's dashboard and restart Postgres as required by the provider.

Each database-connected Walter instance needs one replication slot and one replication sender, in addition to capacity used by your other clients. See [Postgres replication configuration](https://www.postgresql.org/docs/18/logical-replication-config.html).

Use a database endpoint that supports logical replication. A connection pooler's transaction endpoint cannot replace that connection; check the endpoint your database provider supplies for replication.

## Configure the connection

For Docker or Compose, create a file named `walter.env` with your connection string:

```dotenv
WALTER_PG=postgres://USER:PASSWORD@DATABASE_HOST:5432/DATABASE

# Optional: uncomment to restrict Walter to these tables.
# WALTER_TABLES=public.tasks,public.users
```

By default, Walter serves all tables. Uncomment `WALTER_TABLES` to choose a subset, including any tables used by joins or nested queries.

Use a database hostname reachable from the container. `localhost` inside a container refers to that container. If Postgres is in the same Compose project, use its service name as the database host. Include any TLS settings required by your database provider in the connection string.

## What Walter sets up automatically

On startup, Walter:

- Creates or updates `walter_pub`, the publication listing the tables whose changes Postgres sends to Walter.
- Sets `REPLICA IDENTITY FULL` on those tables so updates and deletes include the old row values Walter needs.
- Reads columns, types, and keys to check subscription queries.

Changing replica identity requires a table lock and can increase the amount of WAL produced by updates and deletes. Plan the first setup of busy tables accordingly. See the [Postgres replica identity reference](https://www.postgresql.org/docs/18/sql-altertable.html#SQL-ALTERTABLE-REPLICA-IDENTITY).

Walter creates no application tables and requires no extensions or triggers. The publication and replica identity settings remain after the engine stops. Its replication slot is temporary and is removed when the replication connection ends.

### Database permissions

The role needs database connection, schema usage, table read, and logical replication privileges. It must also be allowed to call `pg_logical_emit_message`, which Walter uses for consistency without modifying application rows.

For automatic setup, the role needs to create or modify `walter_pub` and alter the served tables. The default all-table publication requires a superuser; an explicit table list requires `CREATE` on the database and ownership rights on those tables. See [publication permissions](https://www.postgresql.org/docs/18/sql-createpublication.html#SQL-CREATEPUBLICATION-NOTES).

<details>
<summary>Administrator-managed setup and managed databases</summary>

An administrator can prepare the publication and replica identity settings ahead of time so the runtime role does not need to change them. They must match the default all-table mode or your chosen table list. On Postgres 18, the publication must also use `publish_generated_columns = stored`. Managed services may provide replication privileges through a provider-specific role.

Walter expects complete changes for the tables it serves. Do not add publication row filters, column lists, or custom publication options. Per-user access belongs in [your application's authorization logic](/docs/access-control/).

</details>

## Start the engine

Choose one of the following methods. Docker and Compose read the same `walter.env` file.

### Docker

```bash
docker run -d --name walter \
  --env-file walter.env \
  -p 127.0.0.1:5544:5544 \
  ghcr.io/walter-sql/engine:latest
```

This starts the engine at `ws://127.0.0.1:5544`, accessible from your machine. The image includes Node.js and runs as a non-root user.

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

An application server in the same Compose project connects to `ws://walter:5544`. You can omit `ports` if host access is unnecessary. If you already used the standalone Docker command, stop that container first to free the port.

Compose health checks test the engine process at `/live`. Check its Postgres connection with `/ready`, as shown below.

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
