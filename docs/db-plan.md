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

### Milestone 3 — Query engine — ✅ COMPLETE

Operator-aware filter matching, `sort`/`skip`/`limit`, projections, and an
equality-index planner, all in a new `c/query.h`/`c/query.c`, replacing
`db.c`'s milestone-1 placeholder byte-equality matcher (`dc_matches`,
removed).

- **Operators implemented**: `$eq` (and bare-value equality), `$ne`, `$gt`,
  `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$and`, `$or`,
  `$nor`. Multiple operators on one field are ANDed
  (`{age: {$gte: 18, $lt: 65}}`). Dot-notation nested field paths
  (`"a.b.c"`), descending through OBJECTs only. Array fields match
  element-wise (any element, or the whole array value) for every operator
  except `$exists` — MongoDB's default array-field behavior for a plain
  path, without `$elemMatch`'s element-wide-AND semantics. An unrecognized
  `$`-operator (`$regex`, `$type`, `$size`, `$all`, `$elemMatch` — not
  implemented) is a hard error, never a silent no-op that would look like
  it matched everything.
- **Deliberately deferred, documented in `query.h`**: `$regex`/`$type`/
  `$mod`/`$size`/`$all`/`$elemMatch`; MongoDB's null-matches-missing quirk;
  full cross-BSON-type ordering (comparisons only order number-vs-number
  and string-vs-string; anything else never matches); dotted paths that
  index into an array or fan out over an array of subdocuments.
- **Equality remains exact encoded-byte equality** (per milestone 1's
  rationale) — `$eq`/bare-value/`$in` all reduce to it.
- **`sort`**: a portable hand-rolled merge sort (no `qsort_r`, which has
  incompatible signatures across libc's) with a stable tiebreak by original
  scan order; missing-field-sorts-first, mutually incomparable values
  count as equal for that key. **`skip`/`limit`**: applied after sort, on
  the fully collected + sorted match set (no early-termination streaming
  optimization yet when limit is set without a sort — noted as a future
  refinement, not implemented). **Projection**: inclusion or exclusion
  (not mixed, matching MongoDB), `_id` defaults to included unless
  explicitly excluded.
- **Equality-index planner** (`plan_equality_index` in `db.c`): when a
  filter's top level is a pure AND of bare-value/`{$eq: v}` conditions
  pinning every field of some attached index, `dc_find`/`dc_find_one`/
  `dc_count` use `dc_collection_find_by_index` (built in milestone 2)
  instead of a full scan, then re-apply the *full* filter to that smaller
  candidate set — correctness never depends on which plan was chosen, only
  speed. Deliberately conservative: bails to a full scan the moment the
  filter's top level has any `$and`/`$or`/`$nor`, and only ever does
  equality lookups — no partial-prefix + range index usage yet (e.g.
  `{team: 'core', age: {$gt: 30}}` cannot use a `{team, age}` compound
  index's range capability, only a `{team}`-only index's equality).
- `Collection.find(filter, options)` in `src/binjson-wasm.js` gained
  `options.sort`/`skip`/`limit`/`projection` and driver-shaped chainable
  `.sort()`/`.skip()`/`.limit()`/`.project()` on the returned cursor (both
  forms set the same state, mixable). `findOne`/`deleteOne`/`replaceOne`/
  `countDocuments` needed no JS changes at all — they already called into
  `dc_find_one`/`dc_count`, which automatically gained operator support and
  planner use on the C side.
- Consolidated `obj_get_field` (was duplicated in `db.c` and `query.c`)
  into `bjcursor.h` as a shared `static inline`, and added `dbuf_dup` to
  `dbuf.h` (was `db.c`'s local `dup_bytes`, now also used by `query.c`) —
  matching `bjcursor.h`'s own stated purpose of centralizing helpers that
  would otherwise be copy-pasted across the C data structures.
- `test/db.test.js` — 13 new tests (each operator family, dot-paths, array
  matching, unrecognized-operator rejection, sort incl. compound,
  skip+limit after sort, inclusion/exclusion projection, findOne/deleteOne/
  replaceOne/countDocuments operator support, and an explicit planned-vs-
  scanned agreement test covering: fully-pinned equality plan, equality
  plan plus a non-indexed extra condition, a range condition that can't be
  planned, and a top-level `$or` that can't be planned).

All C sources (`binjson.c`, `bjfile.c`, `hostio.c`, `bplustree.c`, `geo.c`,
`rtree.c`, `diff.c`, `textlog.c`, `stemmer.c`, `textindex.c`, `keyenc.c`,
`query.c`, `db.c`) compile and link cleanly together natively, in addition
to the Emscripten/WASM build.

### Milestone 4 — Update operators — ✅ COMPLETE

`updateOne`/`updateMany` with `$set`/`$unset`/`$inc`/`$push`/`$pull` and
upsert, in a new `c/update.h`/`c/update.c`, wired into `db.c` alongside
`dc_replace_one`.

- **Operators implemented**: `$set` (create or overwrite, spliced verbatim
  — no decode/re-encode needed), `$unset` (drop the field; no-op if
  absent), `$inc` (numeric, INT-vs-FLOAT result chosen by the same
  safe-integer rule the JS encoder uses; errors if the existing field or
  the operand isn't a number), `$push` (append one element, creating a
  fresh array if the field is absent; errors if it exists and isn't an
  array), `$pull` (remove every element *byte-equal* to the operand; no-op
  if the field is absent; errors if it exists and isn't an array).
- **Scope, deliberately conservative** (documented in `update.h`): target
  field names are top-level only — no dotted paths, no auto-vivifying
  intermediate objects (real MongoDB behavior, not implemented). A field
  may be targeted by at most one operator per update (MongoDB's own
  "path collision" validation). `_id` can never be targeted. `$push` has
  no `$each`/`$sort`/`$slice` modifiers. `$pull` only matches by literal
  equality, not a query-operator condition
  (`{$pull: {scores: {$lt: 5}}}` is not implemented). An update document
  whose top level isn't entirely `$`-operators is rejected — that's
  `replaceOne`'s job, matching the modern MongoDB driver's own validation
  that `updateOne`/`updateMany` never accept a bare replacement document.
- **Upsert seeds the new document from the filter**, not from an empty
  object: `build_upsert_seed` in `db.c` pulls the filter's top-level bare
  equality conditions (skipping anything under `$and`/`$or`/`$nor` or
  wrapped in an operator expression — the same conservative scope as the
  equality-index planner) into a base document, then runs it through
  `upd_apply` before splicing in the id. This matches real MongoDB's
  upsert-from-filter behavior, e.g. `updateOne({name:'Ghost'},
  {$set:{team:'core'}}, {upsert:true})` creates `{name:'Ghost',
  team:'core', _id:...}`, not just `{team:'core', _id:...}`.
  `dc_update_one`/`dc_update_many` otherwise mirror `dc_replace_one`'s
  index-maintenance and (for `_many`) `dc_find`'s planner-aware
  matched-document gathering exactly.
- **`updateMany` does not detect no-op updates**: every matched document
  is written and counted as modified, so `modifiedCount` always mirrors
  `matchedCount` — no byte-comparison of old vs. new to catch e.g. `$set`
  to a field's current value (documented simplification, not a hard
  architectural limit).
- `dcw_update_many` is the first `dcw_*` function whose result is a
  *structured* value (`{matchedCount, upserted}`) rather than a single
  int/double — built as a small binjson object directly in `db_wasm.c`
  and written through the existing `dcw_out` slot, the same one
  `dc_find`/`dc_collection_find_by_index` already share.
- `Collection.replaceOne`'s three-buffer (filter + second-doc + default-id)
  marshaling was factored out into a shared `_marshalTriple` helper in
  `src/binjson-wasm.js`, now used by `replaceOne`/`updateOne`/`updateMany`
  — the third real use is what justified extracting it.
- `test/db.test.js` — 15 new tests (each operator, combined operators in
  one call, replacement-document/unknown-operator/`_id`-target/double-
  target rejection, no-match/no-upsert no-op, upsert seeded from the
  filter including the operator-expression-fields-excluded case,
  `updateMany` matching several documents, `updateMany` upsert, and index
  maintenance on an indexed field change).

All C sources, now including `update.c`, continue to compile and link
cleanly together natively in addition to the Emscripten/WASM build.

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
