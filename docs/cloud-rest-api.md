# Cloud service REST API: CRUD + cursor pagination

Follow-on from [`platform-strategy.md`'s Use case 3](platform-strategy.md#use-case-3-lightweight-cloud-database-service):
the transport for `Collection`/`Db` CRUD calls in the hosted service. This
document covers request/response shape, cursor pagination, and errors for
the REST half only. `watch()` (change streams) is push-based and belongs on
the separate WebSocket channel — not covered here.

Everything below is a **wire-level reference for the gateway and worker
implementers**, not the client-facing API — the `MongoClient`-shaped driver
shim (see prior discussion) is what application code actually sees; it
translates `collection.find(...)` calls into the HTTP calls below and
translates the responses back into `ObjectId`/`Date`/cursor objects. A
customer building directly against the REST API (no shim) can use it as-is,
but it isn't designed to be hand-friendly — `Collection`'s JS method shape
already is that, and the shim is what delivers it.

## Contents

- [Scope & non-goals](#scope--non-goals)
- [Routing & auth](#routing--auth)
- [Tenant = database, for v1](#tenant--database-for-v1)
- [Wire format for documents](#wire-format-for-documents)
- [Endpoint reference](#endpoint-reference)
- [Cursor pagination protocol](#cursor-pagination-protocol)
- [Error format](#error-format)
- [Idempotency for writes](#idempotency-for-writes)
- [Open questions](#open-questions)
- [Implementation steps](#implementation-steps)

## Scope & non-goals

- In scope: every `Collection`/`Db` method that isn't `watch()`.
- Out of scope: MongoDB wire protocol, aggregation pipeline, multi-document
  transactions — none of these exist in the engine yet (see
  [`db-api.md`'s scope-limits section](db-api.md#not-implemented--explicit-scope-limits)),
  so there's nothing for this transport to expose for them either.
- Out of scope: `watch()` — see the (separate, not-yet-written) WebSocket
  subscription protocol doc.

## Routing & auth

`Authorization: Bearer <api-key>` on every request. The **API key resolves
the tenant** — tenant id never appears in the URL. Two reasons:

1. Removes an entire IDOR bug class: there's no path segment to edit to
   reach another tenant's data. The only way to see tenant B's data is to
   possess tenant B's key.
2. Keeps the gateway's routing logic uniform: `key → tenant → lease →
   worker` is one lookup chain regardless of which endpoint is being called.

Any admin/ops surface that needs to address a tenant explicitly (support
tooling, the control plane itself) is a separate internal API, not this one.

## Tenant = database, for v1

Real MongoDB's `client.db(name)` selects among multiple logical databases
on one server. Here, one tenant already maps to exactly one binjson `Db`
(catalog + collection files) — that's the whole point of database-per-
tenant. **Decision: for v1, `db(name)` in the client shim always returns
the same tenant-scoped `Db`; `name` is accepted for driver-shim
compatibility but not used for routing.** A tenant needing multiple logical
databases later can be layered as a collection-name prefix
(`{dbName}__{collName}`) inside the existing single catalog, without any
wire-format change — deferred until a real customer asks for it, not
designed now.

## Wire format for documents

Plain `JSON.stringify` can't round-trip `ObjectId`/`Date`/binary — the same
problem MongoDB's own drivers solve with [Extended
JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/).
Reuse that convention (relaxed mode) instead of inventing one, so it's
already documented and any Mongo-familiar reader recognizes it on sight:

```json
{
  "_id":       { "$oid": "507f1f77bcf86cd799439011" },
  "name":      "Ada",
  "createdAt": { "$date": "2024-01-01T00:00:00.000Z" },
  "avatar":    { "$binary": { "base64": "Zm9v", "subType": "00" } }
}
```

One binjson-specific extension beyond standard Extended JSON: the
`Pointer` type (not a Mongo concept) serializes as `{ "$pointer":
"<uint64 as decimal string>" }`. Flag this explicitly in client docs as a
non-standard extension — string, not number, to avoid precision loss above
2^53.

The client shim encodes/decodes this transparently; application code using
the shim only ever sees plain `ObjectId`/`Date`/`Uint8Array` values, same as
today's embedded API.

## Endpoint reference

All bodies are Extended JSON. All responses `200` unless noted. `{coll}` is
the collection name (URL-encoded; `/` and NUL are already illegal in names
per the embedded API).

| Method & path | Body | Response | `Collection`/`Db` method |
|---|---|---|---|
| `POST /v1/collections/{coll}/insert-one` | `{ document }` | `{ insertedId }` | `insertOne` |
| `POST /v1/collections/{coll}/insert-many` | `{ documents[], ordered? }` | `{ insertedIds[] }` | `insertMany` |
| `POST /v1/collections/{coll}/find-one` | `{ filter?, projection? }` | `{ document \| null }` | `findOne` |
| `POST /v1/collections/{coll}/find` | `{ filter?, projection?, sort?, skip?, limit?, batchSize? }` | `{ batch[], cursorId \| null }` | `find` (see [cursor protocol](#cursor-pagination-protocol)) |
| `GET /v1/cursors/{cursorId}/next?batchSize=N` | — | `{ batch[], cursorId \| null }` | cursor continuation |
| `DELETE /v1/cursors/{cursorId}` | — | `204` | close cursor early |
| `POST /v1/collections/{coll}/update-one` | `{ filter, update, upsert? }` | `{ matchedCount, modifiedCount, upsertedId? }` | `updateOne` |
| `POST /v1/collections/{coll}/update-many` | `{ filter, update, upsert? }` | `{ matchedCount, modifiedCount }` | `updateMany` |
| `POST /v1/collections/{coll}/replace-one` | `{ filter, replacement, upsert? }` | `{ matchedCount, modifiedCount, upsertedId? }` | `replaceOne` |
| `POST /v1/collections/{coll}/find-one-and-update` | `{ filter, update, upsert?, returnDocument? }` | `{ value }` | `findOneAndUpdate` |
| `POST /v1/collections/{coll}/find-one-and-replace` | `{ filter, replacement, upsert?, returnDocument? }` | `{ value }` | `findOneAndReplace` |
| `POST /v1/collections/{coll}/find-one-and-delete` | `{ filter? }` | `{ value }` | `findOneAndDelete` |
| `POST /v1/collections/{coll}/delete-one` | `{ filter? }` | `{ deletedCount }` | `deleteOne` |
| `POST /v1/collections/{coll}/delete-many` | `{ filter? }` | `{ deletedCount }` | `deleteMany` |
| `POST /v1/collections/{coll}/count-documents` | `{ filter? }` | `{ count }` | `countDocuments` |
| `GET /v1/collections/{coll}/estimated-count` | — | `{ count }` | `estimatedDocumentCount` |
| `POST /v1/collections/{coll}/distinct` | `{ field, filter? }` | `{ values[] }` | `distinct` |
| `POST /v1/collections/{coll}/bulk-write` | `{ operations[] }` | `{ insertedCount, matchedCount, modifiedCount, deletedCount, upsertedIds[] }` | `bulkWrite` |
| `POST /v1/collections/{coll}/indexes` | `{ keys, options? }` | `{ name }` | `createIndex` |
| `GET /v1/collections/{coll}/indexes` | — | `{ indexes[] }` | `listIndexes` |
| `DELETE /v1/collections/{coll}/indexes/{name}` | — | `204` | `dropIndex` |
| `GET /v1/collections` | — | `{ collections[] }` | `listCollections` |
| `DELETE /v1/collections/{coll}` | — | `204` | `dropCollection` |

**Why `POST` for `find`/`findOne`, not `GET` + query string:** filters are
arbitrarily nested objects with Extended-JSON-typed leaves
(`ObjectId`/`Date`/regex) — they don't fit cleanly in a query string. Same
reason Elasticsearch's `_search` and DynamoDB's `Query` are POST-with-body
APIs rather than GET.

Referencing a collection name implicitly creates it (matches the embedded
`db.collection(name)` "open or create" semantics) — so there's no 404 for
"collection doesn't exist" anywhere in this table. The only 404 is a
missing/expired cursor.

## Cursor pagination protocol

`find()` in the embedded API is lazy — nothing executes until `.toArray()`
or iteration starts. The client shim preserves that by buffering
`filter`/`sort`/`skip`/`limit`/`projection` locally and firing exactly one
`POST /find` on first execution — so this maps onto the embedded semantics
1:1 rather than fighting them.

```
Client                                  Gateway/Worker
  │  POST /v1/collections/users/find     │
  │  { filter: {...}, batchSize: 100 }   │
  ├──────────────────────────────────────>
  │                                       │  opens iterator, reads batch 1
  │  200 { batch: [100 docs],             │
  │        cursorId: "w3.lz9k.a1b2" }     │
  <──────────────────────────────────────┤
  │                                       │
  │  GET /v1/cursors/w3.lz9k.a1b2/next    │
  ├──────────────────────────────────────>
  │  200 { batch: [100 docs],             │
  │        cursorId: "w3.lz9k.a1b2" }     │
  <──────────────────────────────────────┤
  │            ... repeat ...             │
  │  GET /v1/cursors/w3.lz9k.a1b2/next    │
  ├──────────────────────────────────────>
  │  200 { batch: [37 docs],              │
  │        cursorId: null }   ← exhausted │
  <──────────────────────────────────────┤
```

- **`cursorId: null` in the response** means "no more data" — the server
  has already closed the iterator, no follow-up call needed. This also
  covers the common case where the whole result fits in the first batch:
  no server-side cursor resource is ever allocated for it.
- **Cursor id encodes routing, not just an opaque handle**: `{workerId}.
  {tenantLeaseToken}.{localHandle}`, base64url + HMAC-signed by the
  gateway. Lets the gateway route `/next` calls straight to the owning
  worker without a control-plane lookup on every page — the id itself
  carries the answer. The signature stops a client from forging another
  tenant's cursor id (the lease token wouldn't validate).
- **Lifecycle**: idle TTL (default 60s, refreshed on each `/next`) auto-
  closes abandoned cursors so a client that crashes mid-iteration doesn't
  pin a WASM iterator on a worker forever. `DELETE /v1/cursors/{id}` closes
  early, mirroring the real driver's `cursor.close()`.
  **v1 decision: a cursor does not survive tenant migration.** If the
  owning worker's lease is revoked (rebalance, eviction) while a cursor is
  open, the cursor dies with it — the next `/next` call gets `404` +
  `CursorNotFound`. Making cursors migration-safe would mean serializing
  live WASM iterator state across processes; not worth building until
  proven necessary. The shim surfaces this as a driver-shaped
  `MongoCursorNotFoundError`, same as real MongoDB — it's an expected,
  nameable failure mode, not a leaky abstraction.
- **`batchSize`**: default 100, server-enforced max 1000 (caller can ask
  for less, never more) — caps how much one response can force the worker
  to buffer.

## Error format

```json
{
  "error": {
    "code": 11000,
    "codeName": "DuplicateKey",
    "message": "E11000 duplicate key error, index: email_1"
  }
}
```

Where the engine's failure maps onto a real MongoDB error, **reuse Mongo's
published code/codeName** (`11000`/`DuplicateKey`, `43`/`CursorNotFound`,
...) so the client shim can throw the same error classes real MongoDB
driver code already knows how to catch (`err.code === 11000`). HTTP status
carries the broad category; body carries the specific one, since the shim
needs the specific one to reconstruct the right error class:

| HTTP status | Meaning |
|---|---|
| `400` | Malformed body / invalid filter or update shape / unsupported operator |
| `401` | Missing or invalid API key |
| `404` | Cursor not found or expired |
| `409` | Write conflict (duplicate key on a unique index) |
| `429` | Rate limited |
| `503` | Tenant temporarily unavailable — lease being acquired/migrated. Includes `Retry-After`; the shim retries transient errors automatically here, same as real MongoDB driver's `retryWrites`/`retryReads`, so application code doesn't need to know this happened. |
| `500` | Engine/internal error |

## Idempotency for writes

Optional `Idempotency-Key` header on any write endpoint (`insert-*`,
`update-*`, `replace-one`, `delete-*`, `bulk-write`, `find-one-and-*`). The
owning worker caches `(tenant, key) → response` for 10 minutes; a retried
request with the same key returns the cached response instead of
reapplying the write. This is the concrete payoff of choosing REST for the
CRUD path in the first place — a client that times out waiting for a
response can safely retry without risking a double-insert, which a raw
fire-once RPC call can't offer without building this exact same mechanism
itself.

## Open questions

- Should `bulkWrite` be one atomic unit or best-effort-per-op like the
  embedded API's `ordered`/unordered semantics already imply? (Leaning:
  mirror the embedded semantics exactly, don't invent stronger guarantees
  the engine doesn't have.)
- Compression for large batches (gzip response bodies) — defer until batch
  sizes in practice justify it.
- Does `Idempotency-Key` caching need to survive a worker restart, or is
  in-memory-per-worker enough given a restart already invalidates that
  worker's tenant leases and open cursors?

## Implementation steps

1. Extended-JSON encode/decode helpers (likely shares real logic with the
   existing binjson codec's type model — same value universe, different
   wire format).
2. Gateway: API key → tenant → lease → worker routing; issues signed
   cursor ids.
3. Worker: HTTP handlers that are a thin 1:1 wrapper over the existing
   embedded `Collection`/`Db` methods — same "engine owns logic, host
   marshals" split as the C/WASM boundary, one layer further out.
4. Worker: cursor registry (`localHandle → open iterator + state`), idle
   TTL eviction, teardown on lease revocation.
5. Idempotency-key cache on the worker.
6. Engine-failure → HTTP status/error-code mapping table.
7. Client shim: REST transport + cursor `.toArray()`/`for await` built on
   the pagination protocol above.
8. Test lease handoff mid-cursor explicitly — confirm it fails as
   `CursorNotFound` rather than silently returning wrong/partial data.
