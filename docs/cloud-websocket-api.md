# Cloud service WebSocket API: change stream subscriptions

Companion to [`cloud-rest-api.md`](cloud-rest-api.md), covering the one
piece deliberately left out of it: `watch()`. CRUD has no natural push
model over REST, and `watch()` has no honest expression *without* push — so
it gets the one stateful channel in this system, and nothing else does.
One WebSocket connection per client, multiplexing every subscription that
client holds across every collection it watches.

## Contents

- [Scope & non-goals](#scope--non-goals)
- [Connection & auth](#connection--auth)
- [Message envelope](#message-envelope)
- [Subscribing / unsubscribing](#subscribing--unsubscribing)
- [Change event delivery](#change-event-delivery)
- [No resume: a deliberate scope limit](#no-resume-a-deliberate-scope-limit)
- [Backpressure & slow consumers](#backpressure--slow-consumers)
- [Heartbeat & idle timeout](#heartbeat--idle-timeout)
- [Close codes](#close-codes)
- [Tenant migration mid-subscription](#tenant-migration-mid-subscription)
- [Reconnection (client shim responsibility)](#reconnection-client-shim-responsibility)
- [Open questions](#open-questions)
- [Implementation steps](#implementation-steps)

## Scope & non-goals

- In scope: subscribing to `ChangeStream` events per collection, over one
  multiplexed connection.
- Out of scope: everything CRUD — that's the REST API. This channel never
  carries a `find`/`insertOne`/etc. call.
- Out of scope (same as the embedded API): pipeline-based filtering
  (`$match`/aggregation stages on `watch()`). A `subscribe` message may
  carry a `pipeline` field for shape-compatibility with the embedded
  `watch(pipeline, options)` signature, but the server rejects anything
  non-empty — identical restriction to `Collection.watch()` today. The
  wire protocol shouldn't imply a capability the engine doesn't have.

## Connection & auth

`wss://api.yourapp.com/v1/stream`. Browser `WebSocket` can't set an
`Authorization` header, so auth isn't a connection header here — it's the
first message:

```json
→ { "type": "auth", "apiKey": "sk_live_..." }
← { "type": "authAck" }
```

Any other message sent before `authAck`, or no `auth` message within 5s of
connect, closes the socket (`4401`, see [close codes](#close-codes)). Once
authenticated, the connection is pinned to one tenant for its lifetime —
same "key resolves tenant" rule as the REST API, same reasoning (no tenant
id anywhere a client could edit it).

## Message envelope

Every message is one JSON object, `{ "type": ..., ... }`. Document payloads
inside `event.documentKey`/`event.fullDocument` use the same [Extended
JSON](cloud-rest-api.md#wire-format-for-documents) convention as the REST
API — one wire format for documents across both channels, not two.

| Direction | `type` | Purpose |
|---|---|---|
| → | `auth` | First message, API key |
| ← | `authAck` / `authError` | Auth result |
| → | `subscribe` | Start watching a collection |
| ← | `subscribed` / `subscribeError` | Subscription result |
| → | `unsubscribe` | Stop watching |
| ← | `unsubscribed` | Ack |
| ← | `change` | A change event push |
| → | `ping` / ← `pong` | Liveness (either side may initiate) |
| ← | `error` | Connection-level error (see [close codes](#close-codes)) |

## Subscribing / unsubscribing

```json
→ { "type": "subscribe", "requestId": "r1", "collection": "users", "pipeline": [] }
← { "type": "subscribed", "requestId": "r1", "subscriptionId": "sub_9f2a" }
```

`requestId` is client-chosen, used only to correlate the ack (mirrors
sending a request and getting *a* response, without needing a full RPC
layer) — `subscriptionId` is server-issued and is what every subsequent
`change` message tags. One connection can hold many concurrent
subscriptions (multiple collections, or the same collection more than
once with different local handlers) — the whole point of multiplexing
instead of one socket per `watch()` call.

```json
→ { "type": "unsubscribe", "subscriptionId": "sub_9f2a" }
← { "type": "unsubscribed", "subscriptionId": "sub_9f2a" }
```

Unsubscribing is local to the connection — it never closes the socket.

## Change event delivery

```json
← {
    "type": "change",
    "subscriptionId": "sub_9f2a",
    "event": {
      "operationType": "update",
      "ns": { "coll": "users" },
      "documentKey": { "_id": { "$oid": "507f1f77bcf86cd799439011" } },
      "fullDocument": { "_id": { "$oid": "..." }, "name": "Ada", "team": "kernel" }
    }
  }
```

`event` is exactly the embedded `ChangeStream` event shape (see
[`db-api.md`](db-api.md#change-streams-watch)) — `operationType` ∈
`insert | update | replace | delete`, `fullDocument` absent for `delete`.
No translation layer beyond Extended JSON encoding; the server-side worker
already produces this shape internally, this is just it crossing a socket
instead of an in-process `EventEmitter`.

Delivery is ordered and reliable *within one connection* (WebSocket rides
on TCP) — no dedup or sequence numbers needed while connected. The only
gap is across a disconnect, covered next.

## No resume: a deliberate scope limit

The embedded engine has no durable event log — change events are generated
live, at write time, and cost nothing when no watcher is registered (see
[`db-api.md`](db-api.md#change-streams-watch)). That's a real design
choice already made below this layer, and it means **this protocol cannot
offer resume tokens or replay, full stop** — there's nothing server-side to
replay from. A dropped connection loses whatever changes happened during
the gap; reconnecting starts a fresh subscription from "now," not from
where it left off.

State this plainly to customers rather than papering over it: if a
write must never be silently missed, `watch()` isn't sufficient alone —
pair it with a periodic reconciling read (e.g. `find({ updatedAt: { $gte:
lastSeenTimestamp } })`) the same way real MongoDB change-stream users are
advised to handle resume-token expiry. The failure mode here is just a
zero-length resume window instead of a multi-hour one — not a new category
of problem.

## Backpressure & slow consumers

A subscriber that reads slower than the tenant writes can accumulate an
unbounded outbound queue on the server. Policy: cap each connection's
pending-event queue (default 1000 events or 4MB, whichever first); on
overflow, close the connection (`4413`, see below) rather than buffering
without limit or silently dropping individual events mid-stream — an
explicit "you fell behind, reconnect" is easier to reason about for a
client than either unbounded memory growth on the server or silent gaps
the client can't detect. This is the same "no resume" tradeoff as above,
just triggered by consumer speed instead of network interruption.

## Heartbeat & idle timeout

Most intermediary proxies/load balancers drop WebSocket connections after
~60s of no frames. Server sends `{ "type": "ping" }` every 30s; client
must reply `{ "type": "pong" }` within 10s or the connection is closed
(`1001`). This also bounds how long a dead connection can keep a
worker-side watcher registered — relevant because some write paths
(`updateOne`/`deleteOne` with a non-`_id` filter) do one extra lookup per
affected document *only when a watcher is actually registered*, so prompt
cleanup of dead subscriptions keeps that cost honest.

## Close codes

| Code | Meaning | Client should |
|---|---|---|
| `1000` | Normal closure (client-initiated) | — |
| `1001` | Going away (idle timeout, or server deploy/restart) | Reconnect with backoff |
| `4401` | Auth missing, invalid, or expired | Refresh credentials, don't blind-retry |
| `4409` | Tenant lease revoked/migrated mid-connection | Reconnect (routes to new owning worker), resubscribe |
| `4413` | Slow consumer, queue overflowed | Reconnect; consider narrower subscriptions |
| `4429` | Rate limited: too many *connections* for this tenant | Backoff, don't open more connections |

Subscription-level problems (bad collection name, non-empty `pipeline`,
**and a per-tenant subscription-count cap**) are `subscribeError`
messages, not connection closes — one bad or rejected `subscribe` call
shouldn't take down every other subscription multiplexed on the same
socket. `4429` is reserved strictly for the connection-count cap, checked
at `auth` time — the earlier draft of this doc filed the subscription cap
under the same code, which contradicted this section's own principle;
fixed once the server side was actually implemented
(`service/rate-limiter.js`'s `PerTenantLimitCounter`, one instance each
for connections and subscriptions).

## Tenant migration mid-subscription

A tenant's `Db` lives on exactly one worker at a time (the lease model
from the REST API's routing). If that lease moves — rebalance, worker
restart — every open subscription for that tenant closes with `4409`.
Because there's already no resume guarantee (previous section), this isn't
a new failure mode the client has to special-case: "reconnect and
resubscribe from now" is exactly what it already does after any other
disconnect. Migration is boring here specifically *because* `watch()` was
never given continuity guarantees to begin with — one less thing to get
right compared to the REST API's cursors, which do need explicit
`CursorNotFound` handling since a `find()` in progress has query state
worth preserving across a short gap and a change stream doesn't.

## Reconnection (client shim responsibility)

The server keeps no memory of what a disconnected client was subscribed
to — resubscription is entirely on the client. The shim should track its
own "currently watching" set locally and, on reconnect: `auth` → re-issue
`subscribe` for each collection it was watching → resume dispatching to
the same local `ChangeStream` objects application code already holds a
reference to. Exponential backoff with jitter, capped (e.g. 30s), same as
any long-lived-connection client.

## Open questions

- Should a `subscribe` support a server-side `documentKey`-only filter
  (e.g. only this tenant's `orders` collection where `status` changed) to
  cut bandwidth, given `$match` pipeline filtering is out of scope? A
  narrower, non-aggregation filter primitive might be worth it even though
  full `$match` isn't.
- Multiple `subscribe` calls for the same collection on one connection —
  dedupe the underlying worker-side watcher registration (one registration
  fans out to N local subscriptions) or register N times? Leaning dedupe,
  since the cost the embedded API warns about (`updateOne`/`updateMany`
  extra lookups) is per-registration, not per-subscriber.
- Does `4413` (slow consumer) need a grace/warning message before the hard
  close, so a client has a chance to catch up or shed subscriptions first?

## Implementation steps

1. Gateway: WS upgrade handling, `auth` message → tenant/lease resolution
   → proxy to owning worker (same lease lookup the REST gateway already
   does).
2. Worker: subscription registry (`subscriptionId → collection` per
   connection), wired into the existing embedded `ChangeStream`
   `.on('change', cb)` — this is almost entirely "existing `watch()` output
   crosses a socket instead of staying in-process."
3. Extended JSON encode for `change` events (reuse the REST API's codec).
4. Backpressure: per-connection outbound queue with the cap above,
   `4413` close on overflow.
5. Heartbeat ping/pong + idle timeout enforcement.
6. Lease-revocation hook: close all subscriptions for a tenant with `4409`
   when a worker's lease on that tenant ends.
7. Client shim: reconnect/backoff + local resubscription-on-reconnect,
   `ChangeStream`-shaped object wrapping the WS messages so application
   code sees the same `.on('change')`/`for await` surface as the embedded
   API.
8. Load test: many low-traffic subscriptions per connection (multiplexing
   overhead) and one high-traffic subscription (backpressure threshold
   tuning) as separate scenarios — they stress different things.
