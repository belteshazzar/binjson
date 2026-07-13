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

### Milestone 7 — Aggregation pipeline — not doing

`$match`/`$sort` would reuse the milestone-3 query engine directly;
`$group`/`$project`/`$lookup` would be new execution code — the biggest
single chunk of net-new logic in the plan, and nothing else depends on it.
Deliberately deprioritized rather than merely deferred; revisit only if a
concrete use case needs it.

### Milestone 8 — CRUD completeness — ✅ COMPLETE

`insertMany`, `deleteMany`, `findOneAndUpdate`/`findOneAndReplace`/
`findOneAndDelete`, `distinct`, `bulkWrite`, and `estimatedDocumentCount` —
the most commonly hit gaps against the real `mongodb` driver's CRUD
surface. Every one composes existing primitives; no new query/index logic
was needed.

- **Consolidation done first**: `dc_find`, `dc_update_many`, and (still)
  `dc_count` each independently implemented the same "resolve source
  ($text/$near/$geoWithin → equality-index plan → full scan), then filter-
  match, collect matches" branching. Extracted into a shared static
  `gather_matches` (`c/db.c`) that `dc_find`/`dc_update_many` now call,
  and that `dc_delete_many`/`dc_distinct` (both new) also use — would
  otherwise have been the 5th/6th copy. `dc_count` deliberately keeps its
  own lean count-only scan (materializing every match just to count them
  would regress a large unfiltered count from O(1) to O(n) in memory).
  Similarly, `db_query.c`'s dotted-path field resolver and its
  `val_list`/`val_span`/`value_eq` (growable byte-span list + byte
  equality, built for array-element candidate matching) are now exposed
  from `db_query.h` as `qry_resolve_path`/`val_list_push`/`val_list_free`/
  `value_eq`, reused by `dc_distinct` instead of reimplementing dedup.
- **`dc_insert_many`**: loops `dc_insert_one` over a documents ARRAY,
  writing one INT result code per attempted document (`BJ_OK` or an error)
  through the out slot; stops early when `ordered`. `insertedIds` stays a
  client-side concern like every other id — JS already generated each
  document's `_id` before the call, so the C side only reports success/
  failure per index.
- **`dc_delete_many`**: `gather_matches` then, per match, the same
  remove-from-indexes/`bpt_delete`/`commit_journal` sequence
  `dc_update_many` already established — one journal commit per deleted
  document, matching milestone 5's per-document granularity.
- **`dc_find_one_and_update`/`_replace`/`_delete`**: composed in C (not
  JS), consistent with this repo's existing "find X then act on X stays
  in C" precedent (`dc_replace_one`'s own upsert branch). Each captures
  the pre-image via `dc_find_one`, then re-targets the *exact* matched
  document by a new `build_id_filter({_id: <oid>})` helper before calling
  the existing `dc_update_one`/`dc_replace_one`/`dc_delete_one` — so a
  second internal find/update/delete can never land on a different
  document than the one already captured. `return_new` (JS:
  `returnDocument: 'before' | 'after'`) re-fetches by id for the post-
  image. `*found` is 0 only when there's truly nothing to return —
  including the real-MongoDB-matching case of `returnDocument: 'before'`
  with an upsert that had no prior match (no "before" state exists).
- **`dc_distinct`**: `gather_matches`, then per match `qry_resolve_path` +
  a `val_list`-backed dedup by exact encoded-byte equality (same rationale
  as every other equality in this codebase). An array field's *elements*
  are the candidates, not the array itself, matching real MongoDB's
  `distinct()`; documents missing the field contribute nothing (no
  synthetic `null`).
- **`bulkWrite`/`estimatedDocumentCount` are pure JS**, no new C: each
  `bulkWrite` sub-operation dispatches to the already-atomic `Collection`
  method (same reasoning milestone 5 used for `updateMany`'s per-document
  journal granularity — sequencing already-complete atomic units in JS
  doesn't weaken atomicity), aggregating driver-shaped counts and
  supporting `ordered` (stop at first failure, partial result on the
  thrown error's `.result`) or unordered (attempt all, `.writeErrors`
  lists every failure). `estimatedDocumentCount` aliases
  `countDocuments({})`, since that's already `bpt_size` — O(1) on both.
- `Collection` in `src/binjson-wasm.js` gained all six methods; six new
  `dcw_*` WASM exports (`c/db_wasm.c`, `c/build-wasm.sh`) mirror the
  existing one-export-per-operation convention exactly (`dcw_insert_many`,
  `dcw_delete_many`, `dcw_find_one_and_update`/`_replace`/`_delete`,
  `dcw_distinct`).
- `test/db.test.js` — 22 new tests (insertMany ordered/unordered/generated-
  vs-supplied-ids/empty-array-rejected; deleteMany with index maintenance;
  findOneAndUpdate/findOneAndReplace before/after/no-match/upsert-before-
  vs-after; findOneAndDelete; distinct including dotted-path/missing-field/
  array-flattening/filtered; estimatedDocumentCount; bulkWrite mixed-
  operations/ordered/unordered/empty-rejected).

### Milestone 9 — Index options: unique, sparse, partial, TTL — ✅ COMPLETE

`unique`, `sparse`, `partialFilterExpression`, and `expireAfterSeconds`
(TTL) on equality indexes. **Descending (`-1`) index fields are explicitly
excluded** — unlike the other four, it isn't a cheap addition
(`db_keyenc.h`'s order-preserving encoding has no per-field direction
concept; adding one means a second encoding scheme or a direction-aware
B+tree comparator) for a benefit already available today via
`find().sort({field: -1})` (scan direction only, not correctness).
Deferred further, not silently dropped.

- **sparse / partialFilterExpression** share one gate,
  `equality_index_applies` (`c/db.c`): checked by `add_to_one_index`/
  `remove_from_one_index`'s `DC_IDX_EQUALITY` branches before touching
  `build_index_key`/`bpt_add`/`bpt_delete` — a document that doesn't apply
  is silently skipped, the same tolerance text/geo indexes already had for
  a missing field (milestone 6). `backfill_index` needed no changes: it
  already just treats `add_to_one_index`'s `BJ_OK` as "continue."
  `build_index_key` was split into `build_index_key_prefix` (the per-field
  value loop, no id) + itself (prefix + `qk_put_id`), so the unique check
  below can reuse the exact same value encoding
  `dc_collection_find_by_index` already builds for its range bound.
- **unique**: `db_keyenc.h`'s composite key appends an id suffix
  specifically so multiple documents can share a field-value prefix as
  distinct B+tree keys, so `bpt_add` alone can never detect a same-value/
  different-document conflict — `check_unique_one` range-scans
  `[prefix, prefix+upper_bound)` (the same bound-building
  `dc_collection_find_by_index` already does) for any entry at all.
  **Ordering matters more than it first appeared**: an initial design that
  only checked uniqueness inside `add_to_one_index` (reached after the
  primary tree already had the new document) let a *rejected* duplicate
  insert/update still leave the forbidden value sitting in the primary
  tree, visible to `findOne`/full scans, just missing from the unique
  index — the opposite of what the feature promises. Fixed with a second,
  earlier check, `check_unique_indexes`, called *before* any primary/index
  mutation (in `dc_insert_one`; in `dc_replace_one`/`dc_update_one`/
  `dc_update_many` right after `remove_from_indexes`, which already runs
  before the primary write and conveniently also means no self-conflict
  exclusion is needed — the document's own old entry is already gone by
  the time either check runs). The later, in-`add_to_one_index` check
  stays too: it's what makes `dc_collection_add_index`'s backfill refuse a
  `unique` index over a collection with pre-existing duplicate values,
  matching real MongoDB's own `createIndex` behavior, with no separate
  backfill-specific logic.
- **TTL (`expireAfterSeconds`)** needed no new C business logic — a TTL
  index is an ordinary single-field equality index, and expiry is just
  milestone 8's `deleteMany({[field]: {$lt: cutoff}})` — but two
  prerequisite gaps surfaced along the way, both scoped narrowly (not the
  broader cross-BSON-type ordering milestone 11 still owns):
  - `db_query.c`'s `value_cmp` only ordered number-vs-number and
    string-vs-string; a `Date` field (`BJ_TYPE_DATE`, 8-byte int64 millis)
    compared against a `Date` filter operand fell through to
    "incomparable," so `$lt`/`$gt` against dates silently never matched.
    Added a `BJ_TYPE_DATE`-vs-`BJ_TYPE_DATE` case.
  - **Bigger discovery**: `db_keyenc.h`'s `qk_put_value` only encoded
    INT/FLOAT/STRING into an order-preserving index key — a `Date`-valued
    field couldn't be indexed *at all*, so `createIndex({field: 1},
    {expireAfterSeconds})` failed the moment a document was inserted (this
    wasn't caught during planning; only surfaced when the manual smoke
    test tried to actually insert a document). Added a `0x03` date tag to
    `qk_put_value` using the same signed-integer sign-bit-flip total-order
    transform the number case already uses (bit-for-bit, just applied to a
    plain int64 instead of an IEEE-754 double).
  - `Collection.pruneExpired()`: deletes past-cutoff documents for every
    `expireAfterSeconds`-tagged index. No background timer starts on its
    own — **the host must call this periodically** (`setInterval`, or only
    from whichever tab currently holds coordinator leadership,
    `src/db-coordinator.js`), matching the "host-driven timer" framing and
    avoiding a surprise side effect for a caller that didn't ask for one.
- `Collection.createIndex`'s equality path threads `unique`/`sparse`/
  `partialFilterExpression` through `dc_collection_attach_index`/
  `dc_collection_add_index` (`c/db.c`/`db.h`, wider signatures — no new
  WASM exports, the two existing `dcw_collection_attach_index`/
  `_add_index` just grew parameters) via a new shared `_marshalPair`
  helper (`src/binjson-wasm.js`, alongside `_marshalTriple`);
  `expireAfterSeconds` never crosses into C at all, pure catalog
  bookkeeping. `unique`/`sparse`/`partialFilterExpression`/
  `expireAfterSeconds` combined with a `'text'`/`'2dsphere'` key spec is a
  clear JS-side rejection (equality-only, matching how the milestone
  frames all four). `listIndexes()` surfaces the set options, mirroring
  the real driver's shape.
- `test/db.test.js` — 15 new tests (unique: duplicate rejected on insert/
  update/upsert without corrupting the primary document, allowed again
  after the conflicting document is deleted, `createIndex` refuses
  pre-existing duplicates and leaves nothing behind, composes with
  `partialFilterExpression`; sparse: missing-field tolerance on insert/
  backfill/removal; partialFilterExpression: only matching documents
  indexed, add/remove entries as an update crosses the filter boundary;
  TTL: rejects a compound key spec, `pruneExpired` deletes only past-cutoff
  documents; index options survive close/reopen) plus 1 new query-engine
  test proving the `Date` `value_cmp` fix independently of TTL.

### Milestone 10 — Update operator completeness — not started

`db_update.h` implements `$set`/`$unset`/`$inc`/`$push`/`$pull` only, all
top-level-field-only. Gaps, roughly in order of how often real code uses
them: `$addToSet` (like `$push` but only if absent — needs an equality
scan of the array, same byte-equality primitive `$pull` already uses),
`$min`/`$max`/`$mul`/`$rename`/`$currentDate` (each a small, self-contained
addition alongside `$inc` in `db_update.c`), `$setOnInsert` (only applied
on the upsert-insert path — `build_upsert_seed`/`upd_apply`'s callers in
`dc_update_one`/`dc_update_many` already distinguish insert-vs-match, so
this is mostly plumbing), `$pop`/`$pullAll`/`$bit` (smaller, less common).
**Dotted-path targets** (`{$set: {"a.b": 1}}`, rejected today) and
**positional array operators** (`$`, `$[]`, `$[<identifier>]` — target one
array element) are a materially bigger chunk (auto-vivifying intermediate
objects, array-element addressing) and worth splitting into their own
follow-up milestone rather than bundling with the simpler operators above.
`$push`'s `$each`/`$slice`/`$sort`/`$position` modifiers and `$pull`'s
query-operator-condition support (`{$pull: {scores: {$lt: 5}}}`, vs.
today's byte-equality-only) reuse `db_query.h`'s matcher for the condition
case, similar in shape to milestone 3's planner reuse.

### Milestone 11 — Query operator completeness — not started

`db_query.h` implements the comparison/logical family plus `$exists`/`$not`
and (milestone 6) `$text`/`$near`/`$geoWithin`; an unrecognized operator is
a hard error (never a silent no-op), so every gap below is a clean,
discoverable addition rather than a behavior change. Missing, roughly by
real-world frequency: `$regex` (needs a regex engine — the biggest single
piece of new code in this milestone, unlike everything else here), `$size`
(array length — cheap), `$all` (array superset match — cheap, reuses
`$in`'s element-wise shape), `$elemMatch` (element-wide-AND over one array
element, vs. today's per-operator any-element matching — a real semantic
addition, not just a new operator), `$type`, `$mod`. Lower priority /
larger, likely follow-on items: MongoDB's null-matches-missing quirk and
full cross-BSON-type ordering (`db_query.h`'s top comment already documents
both as deliberately out of scope for the comparison operators) — closing
either changes existing matching semantics, not just adding new operators,
so should land as its own reviewed change.

### Milestone 12 — Full multi-document transactions (sessions) — not doing (for now)

Milestone 5 deliberately scoped "transactions" down to per-document-write
atomicity (`docs/db-transactions` design in milestone 5's own writeup) —
explicitly not MongoDB's `startSession()`/`withTransaction()`/multi-
collection ACID surface. Real session support would need a journal that
spans *multiple* `dc_collection`s at once (today's journal is one per
collection) plus a JS-level session object buffering operations until
commit. Substantial new design, not just an extension of milestone 5's
journal. Deprioritized like milestone 7 (aggregation) — revisit only if a
concrete multi-collection-atomicity use case shows up.

### Not planned: change streams (`watch()`)

Real MongoDB's change streams tail the replication oplog, which has no
analog in a single-process embedded store. A reinterpreted local version
(an in-process `EventEmitter`-style hook firing after each committed write,
no resume tokens/durability across restarts) would be cheap to add
whenever a concrete need appears, but is a different feature from the real
API, not a gap in it — not tracked as a milestone.

## Open decisions / risks not yet addressed

- **API target — confirmed, not a risk:** JS API matching the `mongodb`
  Node driver's surface, not the wire protocol. No BSON transcoding needed
  since binjson's `decode()` already returns plain objects/`ObjectId`/`Date`.

## Multi-tab OPFS coordinator — ✅ COMPLETE

Closes the "OPFS concurrency" risk above: `FileSystemSyncAccessHandle`
(every OPFS file in this repo, via `OPFSStorageProvider`/`registerHandle` in
`src/binjson-wasm.js`) takes an exclusive, origin-wide lock per file, so a
second tab opening the same collection used to fail outright. `src/
db-coordinator.js`'s `connectShared(dbName, provider, options)` lets many
tabs/workers share one logical database instead.

- **Mechanism**: Web Locks leader election (`navigator.locks.request`) +
  `BroadcastChannel` RPC, chosen over a `SharedWorker`-as-sole-owner design
  specifically because iOS Safari has never supported `SharedWorker` at
  all — using one would have silently broken multi-tab on a platform this
  repo already targets via OPFS's own Safari 16.4+ requirement. Both APIs
  work everywhere OPFS itself already requires.
- **Runs entirely inside each tab's own worker** — no main-thread/worker
  protocol to design. This repo already requires OPFS access to happen
  inside a dedicated `Worker` (README.md, `public/worker.js`), and
  `navigator.locks`/`BroadcastChannel` are both available there too, so
  leader election, RPC, and the real `Db` all live in the same worker every
  tab already needs; the tab's main thread is unaware any of this exists.
- Exactly one calling context becomes leader (the only one that actually
  calls `connect()`/opens OPFS files); every other context gets a `SharedDb`/
  `SharedCollection` facade (same public API as `Db`/`Collection`) that
  proxies every call over one `BroadcastChannel` per `dbName`, with payloads
  **binjson-encoded** (`encode`/`decode` from `src/binjson.js`) rather than
  JSON so `ObjectId`/`Date` survive the trip. A follower re-checks its role
  at call time, not just at connect time, so a tab that starts as a
  follower and later gets promoted (the previous leader closed) starts
  serving its own calls locally with no facade change.
- **Handover**: on a timed-out request, a follower re-broadcasts
  `whoIsLeader` and gives a new leader a bounded window to appear before one
  retry; the leader also heartbeats an `announce` every 2s so followers that
  joined late self-heal without needing a failed request first.
  Deliberately conservative (one bounded retry, not open-ended backoff) —
  matches this repo's documented-limitation style elsewhere over building a
  fully general retry system for an edge case.
- **Tests**: `test/db-coordinator.test.js` (5 tests, plain Node — modern
  Node ships spec-compliant `navigator.locks`/`BroadcastChannel` globals, so
  this exercises the real election/RPC/handover code paths, just without
  real OPFS or real separate Worker isolates) and `test/
  db-coordinator.browser.test.js` (real Chromium via `npm run test:browser`
  — real Workers standing in for tabs, since Workers of one origin already
  share OPFS/Locks/BroadcastChannel the same way tabs do; covers the one
  thing the Node suite can't: an abrupt `Worker.terminate()` releasing a
  held Web Lock, not just a graceful `close()`).
- `package.json` gained a `"./db-shared"` export (`src/db-coordinator.js`)
  alongside the existing `"./db"` — `src/db.js`/`connect()` are completely
  unchanged, so existing single-tab consumers see no difference.
