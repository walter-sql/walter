# Auction demo

A live auction house on Walter. Every view is a SQL query held live - joins, aggregates, nested relations, top-k windows - streamed through an authenticated oRPC server into TanStack Query.

## Run it

From this directory, start Postgres and the engine:

```sh
docker compose up -d --build
```

From the repo root, install, build the engine, and start the app:

```sh
pnpm install && pnpm build
pnpm demo
```

Open http://localhost:5173 and sign in with any name. The market bot lists, bids, and closes lots by writing straight to Postgres - Walter reads the commits off the WAL, so the UI moves without the API ever being called. Writes from `psql` land the same way.

## What's where

- `docker-compose.yml` - the canonical integration reference: Postgres with `wal_level = logical` plus the Walter engine, nothing else. Swap the `build` for the published image in your own stack.
- `db/init.sql` - schema and seed, applied by Postgres on first boot.
- `server/` - oRPC over node http: cookie sessions, shapes built server-side, event iterators forwarding engine streams, transactional writes, and the bot.
- `web/` - Vite + React + TanStack Router and Query; `liveQueryOptions` from `@walter-sql/tanstack-query` keeps every `useQuery` live.

Each page shows the exact SQL it is subscribed to - open "The SQL behind this view".
