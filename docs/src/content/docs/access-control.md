---
title: Access control
description: Choose queries on the server and keep long-lived subscriptions within each user's permissions.
section: Build your app
order: 2
---

Walter connects to Postgres using one database role. It does not receive your users' sessions, check their permissions, or apply a different database role for each subscription. Your application server must decide which data to request.

## Keep SQL on the server

Let the browser request an application operation, such as “my tasks” or “comments on task 42.” Your server authenticates that request and builds the SQL.

For a private task list, use the authenticated user's ID as a parameter:

```sql
SELECT id, title, done
FROM tasks
WHERE assignee_id = $1 AND NOT done
ORDER BY id DESC
LIMIT 20
```

The server supplies `$1` from its session. The browser does not choose it. Parameters keep values separate from SQL syntax; they do not establish whether a caller has access to those values.

For a shared resource, check access to the requested resource before subscribing. A valid task ID is not an access check. Select only the fields the endpoint is allowed to return, including fields inside nested objects.

## Account for permission changes

A subscription may outlive the request that originally authenticated it. Checking membership when the stream opens does not automatically revoke that stream when membership changes later.

There are two useful approaches, depending on where your permissions live:

- **Include database-backed permissions in the query.** For example, a supported `EXISTS` condition can require a current membership row. Changes to that row then change the query result. The membership table must be published too.
- **End subscriptions when access changes.** If permission depends on a session or an external service, your server must cancel affected streams and check access again before reopening them.

For example, if `project_members` has integer `project_id` and `user_id` columns, a project task query can include:

```sql
SELECT t.id, t.title, t.done
FROM tasks t
WHERE t.project_id = $1
  AND EXISTS (
    SELECT 1
    FROM project_members m
    WHERE m.project_id = t.project_id AND m.user_id = $2
  )
ORDER BY t.id DESC
LIMIT 20
```

`$1` is the requested project and `$2` is the authenticated user. A membership deletion removes that project's tasks from this result when Walter processes the change. This does not expire the user's session or erase rows the browser has already received. Account for those separately in your application.

This example also illustrates a performance tradeoff: an `EXISTS` filter currently prevents the bounded-memory optimization for ordered limits. See [memory and performance](/docs/performance/).

## Protect the engine connection

Run Walter on a private network reachable by your server. Its default bind address is `127.0.0.1`. When connecting across hosts, configure the bind address and network access deliberately.

`WALTER_SECRET` requires a bearer token on the engine's WebSocket handshake. Supply it using `new EngineClient(url, { secret })`. This authenticates a server connection; it does not restrict that server to particular users' rows.

The engine rejects WebSocket handshakes with an `Origin` header. That blocks ordinary browser connections, but is not a substitute for network access controls or the shared secret. Keep database credentials and the engine secret out of frontend bundles.

## Database policies and logs

Postgres row-level security is not a per-user authorization system for Walter subscriptions. There is no per-request user context in the engine's database sessions. Logical replication also has its own [security behavior](https://www.postgresql.org/docs/18/logical-replication-security.html); do not assume that the policies used by your application's database connections will filter each live result for its caller.

Rejected queries throw on the server and can include SQL in their error text. Log the detail there, then send the browser your application's normal error response. A `failed` view message contains no diagnostic text and can be forwarded with the other view messages.
