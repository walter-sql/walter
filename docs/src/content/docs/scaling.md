---
title: Scaling
description: Distribute query maintenance across owners and serve more subscribers through relays, with deployment and recovery details.
section: Operations
order: 4
---

Walter can run across multiple instances. It distributes distinct query results among **owners** and lets other instances **relay** those results to subscribers. This separates the work of maintaining queries from the work of sending their results to many consumers.

The diagram shows a deployment with a dedicated relay layer: the load balancer sends connections from your application servers to the relays, and each relay subscribes to the relevant owners. Owners can also accept application connections directly. Choose the topology based on whether query maintenance and result delivery need to scale separately.

## Owners and relays

An owner reads changes from Postgres and maintains the queries assigned to it. A relay subscribes to the appropriate owner and forwards its messages. It also retains the current result so a later subscriber can receive a snapshot.

A database-connected owner can relay queries owned by another node. A relay-only node has no `WALTER_PG` and does no database reads or replication.

| You need to distribute                        | Configuration                                   |
| --------------------------------------------- | ----------------------------------------------- |
| Maintenance of many distinct queries          | Add owners to the shared peer list.             |
| Connections and delivery to a larger audience | Add relay-only instances outside that list.     |
| Both kinds of work                            | Use multiple owners and a separate relay layer. |

Adding relays can spread delivery of one popular result across machines. That result's query maintenance still takes place on its owner; one query's computation is not split among owners.

## Choose a topology

For an initial cluster, configure the load balancer's backends as the owner nodes. Each owner can both maintain its assigned queries and relay queries owned by another node. This keeps the deployment smaller and avoids a relay hop when a subscription reaches its owner directly.

Use the dedicated relay layer shown above when connection handling and delivery need to scale independently of query maintenance. Direct application connections to the relays, leaving owners to maintain queries and serve those relays. This moves application connection buffers and delivery to individual subscribers into separate processes. Adding serving capacity then does not require adding Postgres replication streams or changing the owner list.

The relay layer adds a network hop and keeps another copy of each relayed result in memory. Add it when the separation benefits your workload; it is not a requirement for running multiple Walter instances.

Both owners and relays can be load-balancer backends. For the dedicated-layer topology, use a relay-only backend pool so application delivery remains separate from query maintenance. In either arrangement, keep the stable, individual owner addresses in `WALTER_PEERS`.

## Configure owners

Set `WALTER_PEERS` to the same list of owner URLs on every participating instance. Use a stable, direct address for each owner, not a load-balanced address that could reach several different owners.

For example, owner A could run with:

```dotenv
WALTER_PG=postgres://USER:PASSWORD@DATABASE_HOST:5432/DATABASE
WALTER_HOST=0.0.0.0
WALTER_PORT=5544
WALTER_SECRET=REPLACE_WITH_YOUR_SECRET
WALTER_PEERS=ws://walter-a.internal:5544,ws://walter-b.internal:5544
```

Run owner B with the same database, secret, and peer list. Each owner includes its own address in the list. The addresses must be reachable by owners and relays, including the node identified by each address.

All owners use the same Postgres publication, `walter_pub`. Leave `WALTER_TABLES` unset on every owner to use all tables, or give every owner the same explicit list. This keeps startup from changing the publication between different definitions.

## Add relay-only instances

A relay uses the same peer list and secret, without database credentials:

```dotenv
WALTER_HOST=0.0.0.0
WALTER_PORT=5544
WALTER_SECRET=REPLACE_WITH_YOUR_SECRET
WALTER_PEERS=ws://walter-a.internal:5544,ws://walter-b.internal:5544
```

Leave `WALTER_PG` unset, and do not put the relay's own URL in `WALTER_PEERS`. Only nodes in that list are selected to maintain queries.

Point your application servers at the relay service or its load balancer. Application servers still own authentication and authorization for their users. A relay forwards engine messages; it does not replace that application logic.

## How a query gets an owner

Every node chooses an owner using a deterministic hash of the SQL text, parameter values, and peer URLs. With the same inputs and peer list, nodes choose the same owner without a separate coordinator.

A subscription can enter through any node. If that node owns the query, it maintains it locally. Otherwise it opens or reuses a subscription to the owner and relays the result.

Keep query text consistent in your server's query definitions. Routing uses the SQL text as sent, so differently formatted SQL can select different owners even when the queries are equivalent. Local query deduplication parses SQL, but it does not provide cluster-wide deduplication of all equivalent spellings.

Separate instances without a shared peer list each maintain the subscriptions sent to them. A load balancer alone does not distribute ownership or make those instances share query state.

## Load balancing and health

A load balancer in front of the serving nodes must support WebSocket upgrades and long-lived connections. A reconnect can go to a different node; the client resubscribes and receives a new snapshot, so application-level session affinity is not required for query recovery.

Keep peer URLs direct even when application connections use a load balancer. The peer list identifies owners, while the load balancer chooses where an application connection enters the cluster.

Use `/ready` for load-balancer [health checks](/docs/operations/#health-endpoints). A relay-only node reports readiness without checking every upstream owner. Monitor owners individually and verify a subscription through the serving path if you need to check that a result is being delivered.

## When an owner is unavailable

Ownership is determined by configuration, not by a health election. If an owner stops responding, its queries are not automatically reassigned to another node.

Relays that already have those results retain their last rows while the owner is unavailable. A subscription that has no result yet may wait for its first snapshot. When the owner returns, the connection reopens and a fresh snapshot updates the relays and their subscribers.

Other owners can continue maintaining their assigned queries. A healthy relay or a successful load-balancer connection does not mean a result owned by the unavailable node is current.

If you need to move an unavailable owner's queries, change the owner list and restart affected instances with the new configuration. Account for the fresh database reads that rebuilding those results requires.

## Deployments and membership changes

The peer list is read at startup. Adding or removing an owner means deploying an updated list to all owners and relays.

Bring new owners up before directing subscriptions to them. During a rollout, different peer lists can assign the same query to different owners and temporarily duplicate maintenance. Existing relay subscriptions do not migrate just because another node's configuration changed; restarting with the new list establishes the new routes.

Use a coordinated rollout and allow for reconnects, new snapshots, and temporary duplicate state. Keep query and schema changes compatible across the deployed versions. There is no live state-transfer or automatic membership-discovery protocol to configure.

Relay instances can be added without changing the peer list. Existing WebSocket connections remain where they are; new or reconnecting connections can use the additional relay capacity.

## Plan database and instance resources

Each owner opens its own logical replication stream for the publication, including changes to tables used by queries owned elsewhere. More owners distribute query processing and add replication work on Postgres. Provision replication slots, sender connections, and ordinary database connections accordingly.

Connect owners to the Postgres primary. Read replicas are not supported.

Relays add delivery capacity without adding Postgres connections. They still use memory for the results they relay and network resources to send those results to subscribers.

There is no universal subscriber count or throughput figure that describes these different workloads. Measure your query mix, change rate, result sizes, and audience distribution. [Memory and performance](/docs/performance/) describes the relevant costs and measurements.
