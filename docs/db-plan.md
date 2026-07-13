# Document database plan

A MongoDB-driver-shaped document database built on the existing persistent
data structures (`bplustree.c`, `rtree.c`, `textindex.c`, `textlog.c`),
targeting a JS API compatible with the `mongodb` Node driver's surface
(`collection.find()`/`insertOne()`/`updateOne()`/...), not the wire protocol.
Embedded/browser-first, backed by OPFS.

## Architecture rule: C/WASM owns the database, JS is a thin bridge

**All database logic — catalog, document CRUD, filter matching, indexing,
query planning, transactions, aggregation — is implemented in C, compiled
into the single combined `lib/binjson.wasm` binary.** JS wrapper classes in
`src/binjson-wasm.js` (exposed via `src/db.js`) do marshaling only: encode a
value with the existing binjson codec, copy bytes across the WASM heap
boundary, call exactly one `*w_*` export per operation, decode the result.
No filtering, scanning, matching, or business logic belongs in JS.

This mirrors the existing pattern for every other structure in this repo:
`BPlusTree`/`RTree`/`TextLog`/`TextIndex` are all thin JS shells over
host-agnostic C (`bplustree.c`, `rtree.c`, `textlog.c`, `textindex.c`) plus a
`*_wasm.c` glue file exposing `EMSCRIPTEN_KEEPALIVE` wrappers. The db layer
follows the same convention: `c/db.h`/`c/db.c` (host-agnostic) +
`c/db_wasm.c` (glue) + `Db`/`Collection` in `src/binjson-wasm.js` (thin
JS). `c/build-wasm.sh` links every `*.c`/`*_wasm.c` file into one `emcc`
invocation — one output binary, `lib/binjson.wasm` — regardless of how many
source files it's assembled from.

**The three things that legitimately stay in JS**, and why each is a real
boundary rather than laziness:
- **Opening/creating storage files.** WASM cannot call OPFS directly; JS
  opens a `FileSystemSyncAccessHandle` (or `MemoryHandle`) and registers it
  as an fd via the existing `hostio.c` bridge (`registerHandle` in
  `src/binjson-wasm.js`). Every structure in this repo already requires this.
- **`_id` (ObjectId) generation.** Needs a clock and a CSPRNG, neither of
  which WASM has a portable source for — the same reason `textlog`'s
  `ts_ms` is host-supplied rather than generated in C
  (`textlog_add_version`). C validates that `_id` is present and OID-typed;
  it never invents one. This also matches real MongoDB drivers, which
  generate `_id` client-side before the wire write.
- **Collection name → backing file name.** A pure deterministic string
  transform (`coll-${name}.bj`), not a decision — JS must compute it before
  it can open the file, so it can't be learned from the catalog first
  (chicken-and-egg). Catalog bookkeeping itself (name → file, list, drop) is
  plain `BPlusTree` key lookups and stays as direct calls into the
  already-thin `BPlusTree` wrapper; there was no new C surface needed for it.

## Milestones

### Milestone 1 — Catalog + Collection primitives — ✅ COMPLETE

Root catalog (`BPlusTree`, collection name → backing file) plus
`insertOne`/`findOne`/`find`/`deleteOne`/`replaceOne`/`countDocuments` on a
single collection. No secondary indexes yet; filters are matched by
top-level field **byte equality** on the encoded values (no `$operators`).

- `c/db.h`, `c/db.c` — host-agnostic collection CRUD + filter matching,
  operating directly on a `bpt*` (documents keyed by the raw 12-byte
  ObjectId, an opaque byte-string bpt key).
- `c/db_wasm.c` — `dcw_*` glue, reusable output slot (`dcw_out_new/free/ptr/len`)
  mirroring `textindex_wasm.c`'s `tixw_out` pattern.
- `Db`/`Collection`/`MemoryStorageProvider`/`OPFSStorageProvider`/`connect`
  in `src/binjson-wasm.js`; `src/db.js` re-exports them as the stable
  `"./db"` package entry point.
- `test/db.test.js` — 20 tests.

Key design notes:
- Filter matching is exact **encoded-byte equality**, not a value-tree
  comparator. Because binjson encoding is a deterministic function of the
  JS value, this is simpler than decoding both sides and happens to
  reproduce real MongoDB's field-order-sensitive embedded-document/array
  equality semantics for free.
- `replaceOne`'s upsert path takes a `default_id` parameter generated
  unconditionally by JS before the call, since whether it's needed is only
  known after C performs the match — avoids a two-phase call.
- Confirmed a real-Mongo-accurate behavior along the way: `{_id: "<hex
  string>"}` does **not** match an ObjectId-typed `_id` (different BSON
  types don't coerce), same as the real driver.

### Milestone 2 — Secondary index manager — ✅ COMPLETE

`createIndex`/`dropIndex`/`listIndexes`, automatic maintenance of
composite-key index entries on `insertOne`/`replaceOne`/`deleteOne`, and
`findByIndex` as a low-level index-scan primitive. Single-field and
compound (multi-field) indexes; no `unique` option yet (rejected with a
clear error rather than silently ignored).

- `c/keyenc.h`, `c/keyenc.c` — order-preserving key encoding, a C port of
  `orderedKey`/`compositeKey`/`compositeUpperBound` (JS versions
  unchanged, still used directly by advanced `BPlusTree` callers). Resolved
  the open question from the milestone-1 writeup **in favor of C**: index
  maintenance now lives entirely inside `db.c`, alongside the CRUD it must
  stay consistent with, keeping the "C owns the logic" rule intact. One
  addition beyond a literal port: a dedicated `0x02` tag for the trailing
  primary-key (ObjectId) suffix, needed so the `compositeUpperBound`-style
  `+0xff` sentinel can't be corrupted by an id byte that happens to be
  `0xff` itself (see `keyenc.h` for the full argument).
- `c/db.h`/`c/db.c` — introduced `dc_collection` (opaque struct bundling
  the primary `bpt*` with zero or more attached `dc_index` registrations);
  every CRUD function's signature moved from `bpt *t` to `dc_collection
  *c`. `dc_collection_add_index` (create + backfill, all-or-nothing) vs.
  `dc_collection_attach_index` (register only, no backfill — for
  reattaching an already-built index on collection reopen, so reopening
  doesn't rescan and redundantly rewrite the whole index every time).
  `dc_collection_find_by_index` added as the low-level equality-lookup
  primitive the milestone-3 planner will dispatch to.
- `c/db_wasm.c` — `dcw_collection_open/free/attach_index/add_index/
  remove_index`, `dcw_find_by_index`; existing `dcw_*` CRUD glue updated to
  take the `dc_collection*` handle instead of a bare `bpt*`.
- `Collection` in `src/binjson-wasm.js` gained `createIndex`/`dropIndex`/
  `listIndexes`/`findByIndex`; its constructor now also takes the shared
  `Db` catalog + storage provider so it can persist/reload its own index
  list (catalog entries grew from `{file}` to `{file, indexes: [{name,
  fields, file}]}`). Still thin: JS's only real work is the driver-shaped
  key-spec validation (`{field: 1}`, ascending only) and default index
  naming (`team_1`, `team_1_age_1`), both pure JS-side conventions, not
  index logic.
- `test/db.test.js` — 12 new tests (createIndex/backfill, maintenance
  across insert/replace/delete, compound indexes, all-or-nothing failure
  on a missing field, dropIndex, duplicate-name/unique/descending
  rejection, persistence + no-redundant-backfill across reopen).

Known gap carried forward (see Milestone 5): index maintenance is not
transactional with the primary write — a crash or a mid-maintenance error
(e.g. an old document field disappearing) can leave an index and the
primary tree inconsistent. Same shape of gap `textindex.c` had before its
own journal milestone (`docs/textindex-atomicity.md`).

### Milestone 3 — Query engine — not started

`$eq`/`$gt`/`$in`/`$and`/`$or`/`$exists`/`$regex`/etc., an index-vs-scan
planner, `sort`/`skip`/`limit`, projections. Replaces `db.c`'s placeholder
byte-equality matcher (`dc_matches`) with a real operator evaluator.

### Milestone 4 — Update operators — not started

`$set`/`$unset`/`$inc`/`$push`/`$pull` + upsert, reusing `replaceOne`'s
splice-in-place pattern (`splice_id` in `db.c`) generalized to arbitrary
field patches. Every changed field must re-run milestone 2's index
maintenance.

### Milestone 5 — Transactions — not started

Cross-document/cross-collection atomicity. Generalize `textindex.c`'s
journal pattern (`tix_recover`, `bpt_rewind`, see
`docs/textindex-atomicity.md`) from "3 fixed trees" to "N collection + index
files touched by one logical operation."

### Milestone 6 — `$text` and geospatial operators — not started

Wire `textindex`'s BM25 query behind `$text`, and `rtree`'s bbox/radius/
nearest behind `$near`/`$geoWithin`. Known gap: `rtree` is point-only, so
`$geoIntersects` and polygon `$geoWithin` aren't covered without extending
it to GeoJSON geometries.

### Milestone 7 — Aggregation pipeline — not started

`$match`/`$sort` reuse the milestone-3 query engine directly; `$group`/
`$project`/`$lookup` are new execution code. Do this last — biggest single
chunk of net-new logic, nothing else depends on it.

## Open decisions / risks not yet addressed

- **OPFS concurrency.** Sync access handles are exclusive per file, so
  multi-tab/multi-worker access to the same database needs a coordinator
  (single writer worker + `BroadcastChannel`/Web Locks for the rest). Not
  designed yet; will shape the `Db`/`Collection` lifecycle once touched.
- **API target — confirmed, not a risk:** JS API matching the `mongodb`
  Node driver's surface, not the wire protocol. No BSON transcoding needed
  since binjson's `decode()` already returns plain objects/`ObjectId`/`Date`.
