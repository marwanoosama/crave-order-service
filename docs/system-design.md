# Order service — system design

Order-service owns order, payment, delivery and settlement state. PostgreSQL is the
authority for orders and money; Redis holds short-lived coordination and cache data.

## Delivery assignment

An order becomes eligible when it reaches `ready`. A worker ticks per region, reads the
oldest ready/unassigned orders, and asks Redis for the nearest agents whose presence is
fresh and who are not busy.

```mermaid
sequenceDiagram
    participant W as assignment worker
    participant DB as regional PostgreSQL
    participant R as Redis
    participant WS as Socket.IO
    actor A as delivery agent
    participant API as order API

    W->>DB: read ready + unassigned batch
    W->>R: GEOSEARCH near branch and filter stale/busy agents
    W->>R: store offer with TTL (NX)
    W->>WS: task.offered to candidate rooms
    A->>API: accept order
    API->>R: claim order (SET NX)
    API->>DB: UPDATE only if still ready and unassigned
    DB-->>API: commit winning agent
    API->>R: mark agent busy and clear offer
    API->>WS: task.assigned to winner and cancel losing offers
    API->>WS: order.status_changed to customer and branch
```

Redis is useful for geo-search and fast contention handling, but it is not the final
authority: the conditional database update guarantees only one agent can own a still-ready
order. Rejections or expired offers are retried on a later tick; after the configured
attempt limit the worker alerts admins and leaves the order ready.

## Customer status and WebSocket

The client authenticates its Socket.IO handshake with the core-issued JWT. The server
derives allowed rooms from that identity and checks every subscription; customers can join
their own `customer:<id>` room, not an arbitrary order room. Socket.IO is mounted at `/ws`.

```mermaid
sequenceDiagram
    actor C as customer
    actor S as restaurant staff or agent
    participant API as order-service
    participant DB as regional PostgreSQL
    participant WS as Socket.IO + Redis adapter

    C->>WS: connect with JWT and subscribe to own room
    S->>API: PATCH order status
    API->>DB: validate actor/state then update in transaction
    DB-->>API: commit
    API->>WS: order.status_changed (after commit)
    WS-->>C: order.status_changed
    Note over C,API: After reconnect, fetch current state with REST
```

The Redis Socket.IO adapter fans events across API instances. WebSocket delivery is
low-latency but not a durable log; `GET /api/orders/:publicId` is the recovery path.

## Authorization

- Core issues JWTs containing the system role and restaurant/branch scope. Customers can
  read their own orders; agents can act only on their assigned order; restaurant users
  are scoped to their restaurant and branch; admins have an explicit bypass.
- Fine-grained `resource:action` checks use permissions fetched from core and cached in
  the order process. They guard branch order-list reads, finance, payments and assignment
  routes.
- Restaurant status updates currently use membership/branch checks plus the order state
  machine; that route does not yet check a fine-grained permission for each transition.
- The permission cache has an event invalidation handler, but core currently does not
  publish `rbac.permissions_changed`; permission changes can remain cached until expiry.

## Regional sharding and time partitioning

These are two different levels: `X-Region` (or the `region` query fallback) selects a
regional PostgreSQL database; inside each database, the `orders` table is range-partitioned
monthly by `created_at`. Only `orders` is partitioned. A default partition catches inserts
outside the pre-created range, while `scripts/create-partitions.ts` maintains the next
12 months and should be scheduled monthly.

Region co-locates the customer, restaurant and delivery agent for the normal read/write
path. The trade-off is that global admin reads may fan out across databases. PostgreSQL
also requires the partition key in parent uniqueness/foreign-key constraints: the order
primary key includes `created_at`, and `order_items` relies on service-level integrity
rather than a foreign key to the partitioned table.

Order items, address text/location, branch coordinates and prices are snapshotted at
placement so later catalog or address edits do not rewrite order history. Money is stored
as integer minor units with a currency.

## Messaging, cache and settlement

- Branch/product data use Redis read-through caches (one-hour TTL); `core.events` refreshes
  or invalidates them. The branch order list has a short cache that is invalidated on writes.
  Redis also stores agent presence, offers, busy flags and Socket.IO pub/sub; none of these
  replace the order database.
- The inbound `core.events` consumer uses manual acknowledgements, Redis `SET NX` event-ID
  dedupe (24 hours) and a dead-letter queue. Replaying a failed message requires clearing
  its dedupe key.
- For emitted events, the domain change and outbound `order.events` row commit together. A
  worker drains each regional outbox with `FOR UPDATE SKIP LOCKED` and broker confirmations.
  Analytics currently aggregates `order.placed` events; see its [consumer design](https://github.com/marwanoosama/crave-analytics-service).
- On `delivered`, one PostgreSQL transaction records any COD collection, commission and
  fee adjustments, updates the restaurant balance, inserts the agent earning, changes the
  order status and writes the outbox event. Redis and WebSocket effects happen after commit.
- The generic `Idempotency-Key` middleware caches responses in Redis for 24 hours; it is
  not itself a transactional lock. Payment webhooks and ledger rows also use database
  uniqueness for durable duplicate protection.
