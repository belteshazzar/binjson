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

- `c/db_keyenc.h`, `c/db_keyenc.c` — order-preserving key encoding, a C port of
  `orderedKey`/`compositeKey`/`compositeUpperBound` (JS versions
  unchanged, still used directly by advanced `BPlusTree` callers). Resolved
  the open question from the milestone-1 writeup **in favor of C**: index
  maintenance now lives entirely inside `db.c`, alongside the CRUD it must
  stay consistent with, keeping the "C owns the logic" rule intact. One
  addition beyond a literal port: a dedicated `0x02` tag for the trailing
  primary-key (ObjectId) suffix, needed so the `compositeUpperBound`-style
  `+0xff` sentinel can't be corrupted by an id byte that happens to be
  `0xff` itself (see `db_keyenc.h` for the full argument).
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
equality-index planner, all in a new `c/db_query.h`/`c/db_query.c`, replacing
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
- **Deliberately deferred, documented in `db_query.h`**: `$regex`/`$type`/
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
- Consolidated `obj_get_field` (was duplicated in `db.c` and `db_query.c`)
  into `bjcursor.h` as a shared `static inline`, and added `dbuf_dup` to
  `dbuf.h` (was `db.c`'s local `dup_bytes`, now also used by `db_query.c`) —
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
`rtree.c`, `diff.c`, `textlog.c`, `stemmer.c`, `textindex.c`, `db_keyenc.c`,
`db_query.c`, `db.c`) compile and link cleanly together natively, in addition
to the Emscripten/WASM build.

### Milestone 4 — Update operators — ✅ COMPLETE

`updateOne`/`updateMany` with `$set`/`$unset`/`$inc`/`$push`/`$pull` and
upsert, in a new `c/db_update.h`/`c/db_update.c`, wired into `db.c` alongside
`dc_replace_one`.

- **Operators implemented**: `$set` (create or overwrite, spliced verbatim
  — no decode/re-encode needed), `$unset` (drop the field; no-op if
  absent), `$inc` (numeric, INT-vs-FLOAT result chosen by the same
  safe-integer rule the JS encoder uses; errors if the existing field or
  the operand isn't a number), `$push` (append one element, creating a
  fresh array if the field is absent; errors if it exists and isn't an
  array), `$pull` (remove every element *byte-equal* to the operand; no-op
  if the field is absent; errors if it exists and isn't an array).
- **Scope, deliberately conservative** (documented in `db_update.h`): target
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

All C sources, now including `db_update.c`, continue to compile and link
cleanly together natively in addition to the Emscripten/WASM build.

### Milestone 6 — `$text` and geospatial operators — ✅ COMPLETE

Reordered ahead of milestone 5 (transactions): text and geo indexes
introduce the other two backing structures a transaction's journal will
eventually need to span (`bpt` composite-key trees from milestone 2,
`TextIndex`'s three trees, `rtree`), so building them first means the
journal generalization in milestone 5 covers all three index kinds from
the start instead of needing a follow-up once text/geo indexes showed up.

`dc_index` (db.c) grew a `kind` (`DC_IDX_EQUALITY`/`DC_IDX_TEXT`/
`DC_IDX_GEO`); a collection may attach a single-field text index (backed by
an open `TextIndex`'s three trees — `textindex.h`) or a single-field geo
index (backed by an open `rtree` — `rtree.h`, GeoJSON Point values only:
`{type:"Point", coordinates:[lng,lat]}`). At most one text index per
collection (matches MongoDB).

- **`$text: {$search: "..."}`** (top-level, not per-field — matches real
  MongoDB) requires an attached text index; runs `tix_query`'s BM25 search
  and resolves the returned doc-id strings back to full documents via the
  primary tree, preserving relevance rank order (no `sort` option ⇒
  results come back in that order, since a plain result-array push
  preserves whatever order candidates were gathered in).
- **`$near`** (`{field: {$near: {$geometry: {type:"Point",
  coordinates:[lng,lat]}, $maxDistance: km}}}`) and **`$geoWithin`**
  (`{field: {$geoWithin: {$box: [[minLng,minLat],[maxLng,maxLat]]}}}` or
  `{$geoWithin: {$center: [[lng,lat], radiusKm]}}}`) both require an
  attached geo index on the named field. `$near` always uses
  `rtree_nearest` (the only rtree query that guarantees sorted output) at
  `k = rtree_size`, then trims to `$maxDistance` client-side rather than
  bounding the rtree call itself — guarantees nearest-first order whether
  or not a distance cap is given. **Deliberate deviations from real
  MongoDB**, both documented in `db.h`'s top comment: distances are in
  **kilometers**, not meters/radians (consistency with `rtree.h`'s own
  km-based API); `$geoWithin` requires an index too (real MongoDB allows an
  unindexed collection scan) — avoids duplicating point-in-shape math in
  `db_query.c` for what's, in practice, an uncommon unindexed-geo-scan case.
  Legacy `$box`/`$center` syntax was chosen over GeoJSON-`$geometry`+
  polygon or `$centerSphere`+radians specifically because it sidesteps
  both the "rtree is point-only, can't do polygons" gap and the
  radians-vs-km unit mismatch.
- **Index maintenance asymmetry, both matching real MongoDB behavior**:
  equality indexes are all-or-nothing (a disqualifying field fails the
  whole write — milestone 2); a *text* index silently skips a document
  missing the field or holding a non-string value (not an error — you
  just can't search for it); a *geo* index silently skips a missing field
  but *errors* on a present-but-malformed GeoJSON value (like a real
  2dsphere index's validation).
- **`resolve_special_source`** (db.c) is a new dispatch step tried
  *before* the milestone-3 equality planner in `dc_find`/`dc_find_one`/
  `dc_count`/`dc_update_many`: it recognizes at most one `$text`/`$near`/
  `$geoWithin` clause at the filter's *top level* only (not nested under
  `$and`/`$or`/`$nor` — falls through to a full scan there, where
  `db_query.c` correctly rejects `$near`/`$geoWithin` as unrecognized
  operators rather than silently ignoring them), resolves it via the
  matching index, and builds a *residual filter* (the original filter
  minus that one clause) to re-apply to each candidate — same
  "candidate-set-plus-full-filter-reapplication" pattern the equality
  planner already established, so correctness never depends on which
  source was used.
- Two small pieces of duplication were consolidated while wiring this in:
  `append_index`/`backfill_index` helpers now back all three
  `dc_collection_add_*_index` functions (previously only the equality path
  had this logic, inline); `ids_to_docs` resolves both text (hex-string
  doc ids) and geo (raw OID field) result sets back to documents through
  one shared function.
- A real bug caught by this refactor, not a pre-existing one: the
  milestone-2 equality planner (`plan_equality_index`) never filtered by
  index kind, so a text/geo index (whose `field_count` is always 0) would
  have looked "fully pinned" by zero fields and been incorrectly selected
  as an equality plan the moment any text/geo index existed. Fixed before
  it could matter (no such index existed yet when it was introduced).
- `Collection.createIndex({field: 'text'})` / `createIndex({field:
  '2dsphere'})` in `src/binjson-wasm.js` dispatch to `_createTextIndex`/
  `_createGeoIndex`; catalog entries grew a `kind` (defaulting to
  `'equality'` for entries written before this milestone) and per-kind
  file bookkeeping (`file` for equality/geo, `files: {index, docTerms,
  docLengths}` for text). No JS query-side changes were needed at all —
  `find`/`findOne`/`updateMany` already delegate to the C functions that
  gained `$text`/`$near`/`$geoWithin` support, and the CLI/example scripts
  needed no code changes either (arbitrary filter JSON already passes
  through unchanged).
- `test/db.test.js` — 15 new tests (text index backfill/maintenance/
  residual-filter/tolerant-of-bad-fields/one-per-collection/persistence;
  geo index backfill/`$near` with and without `$maxDistance`/`$box`/
  `$center`/residual-filter/maintenance/tolerant-missing-but-strict-
  malformed/requires-an-index/persistence).

### Milestone 5 — Transactions — ✅ COMPLETE

Scoped down from the original "cross-document/cross-collection atomicity"
framing to what actually matters for a single-writer embedded database:
**every document write (`insertOne`/`deleteOne`/`replaceOne`/`updateOne`,
and each matched document within `updateMany`) is now atomic across the
primary tree and every attached index's file(s)**, closing milestone
2/6's carried-forward gap. This is not multi-document ACID
sessions/transactions (no `startSession`/`commitTransaction` surface) —
`updateMany`'s documents are not atomic *with each other*, matching real
MongoDB's own non-session behavior; only each individual document's
primary+index write is crash-safe.

- **Generalizes `textindex.c`'s fixed-3-tree journal** (`tix_recover`,
  `bpt_rewind`, `docs/textindex-atomicity.md`) to a variable N: primary tree
  + every attached index's file(s) (equality/geo: 1, text: 3), scoped per
  `dc_collection`. Same mechanism: an append-only file can be rewound to any
  prior commit boundary, which exactly restores that historical, consistent
  state, so a two-slot ping-pong journal recording "how long every file was"
  after each committed write turns multi-file crash recovery into a handful
  of truncate calls. Slot layout: `magic "DCTJ"(4) + version(4) + txn(8) +
  file_count(4) + N×8-byte lengths + crc32(4)`, two slots at offset 0 and
  `slot_size(n) = 24 + 8n`, journal write always last (an operation is
  committed iff its slot landed).
- **`file_count` is part of the CRC'd payload**: a slot whose stored count
  doesn't match the collection's *current* live index count is treated as
  undecodable, same as a CRC failure — this matters because N changes
  whenever `createIndex`/`dropIndex` runs. The journal is truncated to empty
  the moment an index is added or removed (in `db.c`, transparent to the
  host), so every pair of slots ever compared shares the same N; an empty
  journal imposes no constraint regardless of what N becomes next, matching
  `tix_clear`'s own "reset first" convention for a non-atomic structural
  change. Index *creation* itself keeps milestone 2's pre-existing
  all-or-nothing bookkeeping-rollback story, unrelated to and unchanged by
  this journal.
- **Journal I/O is skipped entirely for a collection with no secondary
  indexes** (`commit_journal`/`dc_collection_recover` both no-op when
  `index_count == 0`): a lone primary tree is already atomic on its own (one
  file with its own CRC'd commit trailer), so there's nothing to keep in
  sync and no reason to pay extra synchronous OPFS round-trips per write.
- **`rtree.h`/`rtree.c` gained `rtree_file_len`/`rtree_rewind`**, ported
  near-verbatim from `bplustree.c`'s `bpt_file_len`/`bpt_rewind` using
  rtree's own metadata-record format — the one primitive this
  generalization needed that milestone 6 hadn't required yet.
- **Commit sites**: `dc_insert_one`, `dc_delete_one`, `dc_replace_one`'s and
  `dc_update_one`'s matched-document branches, and once per matched document
  inside `dc_update_many`'s loop (their upsert-no-match branches all
  delegate to `dc_insert_one`, already covered — no double commit). A failed
  journal-commit still surfaces as the operation's error even though the
  underlying tree writes already landed durably, matching `tix_add`'s own
  `if (!e && journal) e = tixj_commit(...)` convention.
- **Always on, no opt-in flag**: unlike `TextIndex`'s optional `journal`
  constructor argument, `Collection` now opens a `coll-${name}-journal.bj`
  file automatically (`Db`/`Collection` in `src/binjson-wasm.js`) — a
  baseline consistency guarantee every collection gets for free, not a
  feature callers request. Recovery (`dcw_collection_recover` /
  `dc_collection_recover`) runs once, right after every catalog index has
  been reattached, mirroring `tix_recover`'s "right after every file is
  open" contract; a failed recovery closes everything back down and throws,
  the same shape as `TextIndex.open()`'s own failure path.
- `test/db.atomic-wasm.test.js` — 9 OPFS crash-simulation tests (normal
  operation stays bounded to two ping-pong slots; a lost journal write and a
  partially-persisted write both roll back whole; falling back to the
  previous slot when the newest is unsatisfiable; refusing to open when
  every file is behind every journal record; `deleteOne`/`replaceOne`/
  `updateOne`/`updateMany` roll back the same way as `insertOne`;
  `createIndex` resets the journal and recovery still works at the new N).
  `test/db.test.js` gained 3 `MemoryStorageProvider` sanity checks (no
  journal I/O for an index-less collection, journal size bounded once
  indexed, normal CRUD unaffected across close/reopen).

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
