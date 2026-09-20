# @walter-sql/engine

[Walter](https://walter.ax) keeps SQL query results up to date as data changes in Postgres.

This package runs the engine alongside Postgres, serving live query results to your application server. The engine is stateless: query state lives only in memory and is rebuilt from Postgres after a restart.

```sh
npm install @walter-sql/engine
```

Run it with the package's `walter` command on Node.js 22 or later, or use the Docker image `ghcr.io/walter-sql/engine`. Postgres must have logical replication enabled.

**[Documentation: installation and startup](https://walter.ax/docs/installation/)**

Apache-2.0
