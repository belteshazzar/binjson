# Platform strategy: web, macOS/iOS, and cloud service

## Context

Three target deployments are on the table:

1. **Web-embedded**: a pseudo-MongoDB document database inside a web page,
   in place of a SQL-style embedded DB.
2. **Native app-embedded**: inside a macOS app, and potentially an iOS app.
3. **Cloud service**: a lightweight, low-cost hosted database offering.

This document assesses what each needs, recommends whether the project
should stay one repo or split, and lays out a phased path to get there.

## Recommendation up front

- **Stay one repo, for now.** Reorganize into clearer internal boundaries
  (already largely in place) rather than splitting into 3 git repos. Revisit
  a real split only when a concrete forcing function shows up (see
  [Repo structure](#repo-structure-one-repo-or-three)).
- **macOS/iOS: embed the existing WASM build inside JavaScriptCore, not a
  native C compile.** Decided (reversing an earlier draft of this
  document, which chose the native path and even got as far as a working
  prototype — see [Use case 2](#use-case-2-macosios-app-embedding) for
  that history). JavaScriptCore is a full JavaScript engine, not just a
  WASM VM, so it can run `src/binjson-wasm.js`/`src/db.js` *verbatim*
  inside the app; the Swift side only needs to provide file I/O and call
  into that unmodified JS API, rather than re-implementing the codec and
  the `Db`/`Collection` API in Swift by hand. Benchmarking (below) also
  showed the actual database operations already run at native speed under
  WASM, so there's no performance reason to prefer native compilation
  either. See [Use case 2](#use-case-2-macosios-app-embedding).
- **Cloud service: don't chase MongoDB wire-protocol compatibility.**
  Implement the real wire protocol only if a concrete customer needs the
  existing `mongodb` driver to point at this unmodified — otherwise a thin
  HTTP/WebSocket API fronting the same JS driver-shaped `Collection` API
  already built is dramatically cheaper and still "pseudo-MongoDB
  compatible" at the application level.

## Current state (what already exists and where it helps)

- **Architecture is already layered correctly for this**: `c/binjson.c` (codec)
  → `c/bplustree.c`/`c/rtree.c`/`c/textindex.c`/`c/textlog.c` (structures) →
  `c/db*.c` (database). Each layer only depends on the one below it. This is
  the exact seam a repo split — or an internal package split — would want.
- **The C core is already proven portable**: every milestone's workflow
  includes `gcc -std=c11 -Wall -Wextra -c <file>.c` as a native (non-WASM)
  syntax-check, and `npm run test:c` builds and runs `c/binjson.c` as a
  plain native binary. This isn't a WASM-only codebase that happens to be
  written in C — it's C that happens to also target WASM.
- **The host I/O boundary is already abstracted**: `c/bjio.h`'s `bj_io`
  vtable (`size`/`read`/`write`/`truncate`, synchronous, context-pointer
  based) is what every persistent structure goes through. `c/hostio.c`
  implements it *for WASM* (via `EM_JS` calls into a JS-side
  `FileSystemSyncAccessHandle`). A native (POSIX) implementation was also
  prototyped and confirmed working, then removed once use case 2 settled
  on JavaScriptCore instead (see below) — recoverable from git history
  (commit `aa92dbd`) if a native build is ever worth reviving.
- **Storage is already provider-abstracted on the JS side too**:
  `MemoryStorageProvider`/`OPFSStorageProvider` implement a 2-method
  contract (`openFile`/`deleteFile`). A Node-native or object-storage-backed
  provider is a small, additive class, not a redesign — directly relevant to
  use case 3.
- **Multi-writer coordination already exists** (`src/db-coordinator.js`,
  shipped this session): leader election + `BroadcastChannel` RPC for many
  browser tabs sharing one OPFS database. Solves the multi-tab half of use
  case 1 already.
- **Change streams already exist** (`Collection.watch()`), useful for both
  use case 1 (live UI updates) and use case 3 (webhooks/subscriptions on a
  hosted database).
- **Gaps that matter across all three**: no TypeScript type definitions, no
  CI (no `.github/workflows`), no published multi-platform build story yet,
  aggregation pipeline and full multi-document transactions are explicitly
  "not doing" in `docs/db-plan.md`.

## Use case 1: Web-embedded document database

### What's already there
OPFS-backed persistence, the full CRUD/query/update/index API
(`docs/db-api.md`), multi-tab sharing, change streams. This is the
most mature of the three today — it's what the project has been built
toward all along.

### Gaps to close
- **No graceful degradation without OPFS.** `OPFSStorageProvider` is the
  only persistent option; browsers without OPFS/sync-access-handles (older
  Safari/Firefox, or non-secure contexts) have no fallback besides
  `MemoryStorageProvider` (non-persistent). An IndexedDB-backed
  `StorageProvider` (async under the hood, but the sync `bj_io`-style
  contract can be satisfied by pre-loading each file's bytes and
  batching writes — the same shape TextLog's tiled/delta storage already
  uses for large-value handling) would let the library degrade instead of
  hard-failing.
- **No TypeScript types.** For a library asking developers to swap out
  their SQL-style embedded DB, editor autocomplete/type-checking on the
  `Collection` API matters a lot for adoption. `typescript` is already a
  devDependency but unused for this — either hand-written `.d.ts` files or
  `tsc --declaration` against JSDoc-annotated sources.
- **Bundle size is monolithic.** `c/build-wasm.sh` always links
  binjson+bplustree+rtree+textindex+textlog+stemmer+diff+db into one 218KB
  `binjson.wasm`, even for a consumer who only wants the document database.
  A second, slimmed build target (binjson+bplustree+db only, no
  rtree/textindex/stemmer/diff) would meaningfully shrink the common case.
- **Aggregation pipeline and full transactions remain out of scope** (per
  `docs/db-plan.md`, milestones 7 and 12) — fine for "SQL replacement" in
  most CRUD-heavy apps, a real gap for anything doing `GROUP BY`-style
  analytics or true cross-collection invariants. Not blocking, but worth
  re-flagging here since this use case is where it'd bite first.
- **No CI.** Nothing currently verifies the WASM rebuild + full test suite
  + browser suite on every change before it's manually run and committed.
- **README/package framing undersells this.** The npm package description
  and README currently center on "binary encoding format"; the document
  database is comparatively buried. If this becomes a primary use case,
  the front door should say so.

### Steps
1. Add TypeScript declarations (hand-written `.d.ts` alongside `src/db.js`
   is the fastest path; generate-from-JSDoc is more upkeep but stays in
   sync automatically — pick one and add a type-check to CI).
2. Add a slimmed WASM build target in `c/build-wasm.sh` (binjson+bplustree+db)
   alongside the existing full build; publish both, let `src/db.js`'s
   consumer choose via a build-time or import-path switch.
3. Add an IndexedDB-backed `StorageProvider` for browsers without OPFS.
4. Stand up CI (GitHub Actions): native C syntax-checks, WASM rebuild, full
   `vitest run`, and the Playwright browser suite, on every push/PR.
5. Reframe the README/package description around "embedded document
   database" as a co-equal headline feature, not a footnote.
6. Revisit aggregation/transactions only if a concrete app built on this
   hits the wall (matches the existing "deprioritized, revisit on demand"
   posture already used for both in `docs/db-plan.md`).

## Use case 2: macOS/iOS app embedding

### Decision: embed the existing WASM build inside JavaScriptCore

Bundle `lib/binjson.wasm` and the existing JS glue (`src/binjson-wasm.js`,
`src/db.js`) unmodified, and run them inside a `JSContext` (JavaScriptCore
ships on both macOS and iOS as a system framework — no App Store engine
restriction, since it's Apple's own JS engine). The decisive point: a
`JSContext` is a *full JavaScript engine*, not merely a WASM VM, so it can
execute `src/binjson-wasm.js`/`src/db.js` exactly as-is — the same
`Db`/`Collection` API, the same `encode`/`decode`, the same `ObjectId`/
`Date` handling, with zero re-implementation. The only genuinely new code
is:
- A Swift-side `StorageProvider` bridge — real POSIX file I/O in the app's
  sandboxed container, exposed into the `JSContext` so the *existing*
  `OPFSStorageProvider`-shaped contract (`openFile`/`deleteFile`, a
  `getSize`/`read`/`write`/`truncate`/`flush`/`close` handle) has something
  to call on iOS/macOS instead of real OPFS.
- A thin Swift-to-JS facade translating Swift calls into `JSContext`
  method invocations and marshaling plain values (numbers/strings/booleans/
  dates/byte arrays) across — no codec or database logic of its own.

This reverses an earlier draft of this document, which chose compiling the
C core natively instead (skipping WASM/JS entirely, via a Swift↔C bridge).
That path was fully prototyped and confirmed working — a native `bj_io`
(POSIX `pread`/`pwrite`/`ftruncate`/`fstat`) and a from-scratch native
rewrite of one of the CLI tools, proven byte-for-byte compatible with its
JS counterpart — before being removed once this decision settled on
JavaScriptCore instead; see commit `aa92dbd` (and the native CLI rewrite
in the commit immediately after it) if that work is ever worth reviving.
Reversed anyway, for two reasons:
- **Running WASM inside a real JS engine means the entire existing JS
  layer runs unmodified.** The native path would have required someone to
  hand-port `binjson-wasm.js`'s codec and `Db`/`Collection` API to Swift —
  real, substantial, ongoing-maintenance-burden new code, duplicating logic
  that already exists and is already tested. Embedding in JavaScriptCore
  needs none of that: the Swift layer is only a host (file I/O + a call
  bridge), the same shape `binjson-wasm.js` itself already is relative to
  the WASM module.
- **Benchmarked, not assumed, that WASM isn't the slow path here** (see
  below) — the actual database operations (inserts, searches, the whole
  `Collection` API) already run at native speed under WASM. There's no
  performance case for native compilation, only a maintenance case against
  it: a second toolchain (a C compiler/linker per target platform, on top
  of Node/Emscripten), and a second host-I/O implementation that can drift
  from the WASM one.

### Native vs. WASM performance (measured, not assumed)

A throwaway benchmark (native compiled with `-O3` to match the WASM
build's own optimization level, vs. the WASM build via Node — same
operations, same counts, in-memory storage on both sides, no disk I/O)
gave:

| Benchmark | Native | WASM (Node) | Ratio |
|---|---|---|---|
| B+Tree insert (50k keys, order 32) | ~72k ops/sec | ~72-89k ops/sec | at parity |
| B+Tree search (50k keys) | ~443k ops/sec | ~423-461k ops/sec | at parity |
| Encode a 4-field document (20k docs) | ~4.7-6.5M ops/sec | ~125-171k ops/sec | native ~30-50x faster |

Tree operations run at native speed either way: each JS→WASM call does
substantial work internally (tree traversal, node splits, all inside
compiled code), so the one-time cost of crossing the boundary is a
rounding error against the work done per call. The encode gap is
architectural: `encode()` in `src/binjson-wasm.js` calls a *separate*
WASM-exported function per field (`_bjw_put_int`, `_bjw_put_key`,
`_bjw_put_string`, ...), so a 4-field document costs ~10 boundary
crossings, each doing only a few bytes of real work — the case where
call/marshaling overhead dominates trivial per-call work. Since the
`Collection` API (what every actual use case here exercises) looks like
the first two rows, not the third, embedding the WASM build costs nothing
in practice.

### Other requirements
- **Storage location**: the app's own sandboxed container (`Application
  Support`/`Documents`), not OPFS — exactly what the Swift `StorageProvider`
  bridge replaces.
- **No `navigator.locks`/`BroadcastChannel` equivalent needed for a single
  app process** — `src/db-coordinator.js`'s multi-tab problem doesn't exist
  inside one app's process. (It would resurface if a macOS app and a
  today-hypothetical Mac Catalyst/sibling process needed to share one
  database file — cross that bridge only if it comes up.)
- **Distribution**: a Swift package bundling the WASM binary, the JS glue,
  and the small Swift facade — standard Swift Package Manager resource
  bundling, no XCFramework/native-library build needed.

### Steps
1. Spike: instantiate `lib/binjson.wasm` inside a bare `JSContext` and call
   one exported function, confirming JavaScriptCore's WASM support is
   solid on current OS versions.
2. Write a Swift `StorageProvider` bridge (POSIX file I/O in the app's
   sandbox container, exposed into the `JSContext`, matching the existing
   `openFile`/`deleteFile` + handle contract `OPFSStorageProvider` uses).
3. Write a thin Swift facade calling the JS `Db`/`Collection` API through
   the `JSContext` (Swift method → JS call → JSON-ish marshaling).
4. Package as a Swift Package Manager library; validate on a throwaway
   macOS app target first, then iOS.
5. Only then decide whether iOS App Store review needs anything special
   (it shouldn't — this is a private, on-device data store with no
   networking, no different from SQLite/Core Data in that respect).

## Use case 3: Lightweight cloud database service

### Requirements
- **Runtime**: Node.js — already proven end-to-end (the `db` CLI tool and
  `test/db-coordinator.test.js` both already run this exact WASM/JS stack
  under plain Node).
- **Storage backend**: a new `StorageProvider` implementation. Two
  reasonable shapes: (a) local disk via `fs`, one directory per tenant
  database — simplest, matches the existing per-directory-catalog model
  exactly; (b) object storage (S3-compatible) for elastic/multi-instance
  hosting — needs a provider that satisfies the same `openFile`/
  `deleteFile` contract, likely with local caching/buffering since object
  storage isn't byte-range-writable the way a local file is (the sync
  `bj_io`-style random-access-write contract doesn't map directly onto
  S3's PUT-whole-object model, so this would need either a WAL-plus-
  periodic-snapshot design or a networked block-storage layer, not a
  naive 1:1 file mapping).
- **Concurrency/multi-tenancy model**: Node is single-threaded per process.
  Realistic options: one Node process (or worker thread) per active tenant
  database, matching `db-coordinator.js`'s own "exactly one owner of the
  real `Db`" model conceptually — just replacing Web Locks/BroadcastChannel
  with a process-manager/queue in front. This is the same shape as
  Cloudflare Durable Objects or LiteFS/Turso's per-database-instance model
  for SQLite, and fits this project's own file-per-collection,
  no-built-in-sharding design far better than trying to run one giant
  multi-tenant process.
- **Wire protocol**: implementing real MongoDB wire protocol would let
  existing `mongodb` driver code point at this unmodified, but it's a large
  undertaking (auth handshake, OP_MSG framing, full BSON-on-the-wire, cursor
  protocol semantics) disproportionate to "lightweight and low cost" unless
  a specific customer needs exactly that. Recommended default: a thin
  HTTP/WebSocket API that mirrors the existing `Collection` method surface
  1:1 (`POST /db/:name/collections/:coll/findOne`, etc., or a single
  WebSocket RPC channel for lower per-call overhead + native `watch()`
  streaming) plus a small official client SDK. Keep wire-protocol
  compatibility as a later option, not a v1 requirement.
- **Durability/backup**: `BPlusTree`'s existing `compact()`/snapshot
  machinery (already built and tested — see `bptw_snapshot`/`bptw_compact`)
  is directly reusable for hosted backups; still needs an operational layer
  (schedule, off-instance copy, restore path).
- **Auth/multi-tenancy isolation**: doesn't exist at all today — every
  layer below (catalog, collections, indexes) assumes one trusted caller.
  Needs an API-key-or-similar auth layer and per-tenant directory isolation
  at the service layer (not inside `db.c`, which shouldn't need to know
  about tenants at all — matches the existing "C owns database logic, host
  owns everything else" split).
- **Observability**: `Collection.watch()` maps naturally onto
  webhooks/websocket push for subscribers — a genuine product feature this
  project already has for free.

### Steps
1. Write a Node `fs`-backed `StorageProvider` (single-tenant local disk
   first — reuses everything else unchanged).
2. Build a thin HTTP/WebSocket API server process wrapping one `Db` per
   tenant directory, using `db-coordinator.js`'s "exactly one owner"
   pattern as the concurrency model (adapted from tabs/workers to
   processes/tenants).
3. Add an API-key auth layer at the service boundary.
4. Add scheduled backup using the existing B+ tree compaction/snapshot
   primitives.
5. Ship a minimal official client SDK (thin wrapper posting to the
   HTTP/WebSocket API, same method names as `Collection` for familiarity).
6. Only after a real customer need appears: evaluate real MongoDB
   wire-protocol compatibility, and/or an object-storage-backed provider
   for elastic hosting.

## Repo structure: one repo, or three?

The proposed split — binjson format/codec, data structures built on it,
database built on those — mirrors the *dependency graph* accurately: it's
a real, clean layering, not an artificial one. That's the strongest
argument for it. But dependency-graph cleanliness and repo-boundary
cleanliness are different questions, and splitting now would cost more
than it returns.

**Arguments for splitting:**
- Enables independent versioning/release cadence per layer.
- Lets a future macOS/iOS or cloud-service consumer depend on just the C
  core without dragging in browser-specific JS/WASM build tooling.
- Smaller repos are easier for outside contributors to evaluate.

**Arguments against splitting now:**
- **Solo-maintainer velocity is the dominant cost.** This session alone
  shipped 5+ database milestones plus tooling/doc work, several of which
  touched `c/binjson.h`/`c/bjcursor.h` *and* `db_query.c`/`db_update.c` *and*
  JS in the same sitting. Cross-repo changes mean cross-repo version
  bumps, `npm link`/local-path juggling during development, and multi-repo
  CI — pure friction for exactly the kind of fast, cross-layer iteration
  this project has been doing.
- **Nothing forces a C-level split yet.** With use case 2 now planned as
  WASM embedded in JavaScriptCore rather than a native compile, macOS/iOS
  consumes the *same* `*_wasm.c`-exported WASM module and the *same* JS
  layer web use does — there's no second, divergent C-facing entry surface
  motivating a separate core package/repo boundary right now.
- **No external forcing function exists yet** — no outside contributors,
  no second team depending on just the codec, no evidence a shared release
  cadence is actually painful in practice.
- Most of the *real* benefit (independent semver, "install just the
  codec") is achievable via **npm workspaces within one repo** — separate
  `package.json`s, separate published package names, one git history, one
  CI pipeline, one PR to land a change that spans layers.

**Recommendation**: keep one repo. If/when it's worth revisiting:
npm-workspaces-split the *JS* side into `@belteshazzar/binjson` (codec +
structures) and a `@belteshazzar/binjson-db` (document database) as
separately published packages, still from this one repo — this alone
captures most of the "install just what you need" benefit for use case 1
without any multi-repo cost. Only actually split into separate git repos
if one of these becomes true: (a) the macOS/iOS Swift package matures into
its own repo naturally because its toolchain (Xcode, SPM) has nothing in
common with the JS/Vitest/Playwright toolchain and sharing a repo is
actively getting in the way; (b) the cloud service grows its own deploy/ops
surface (Dockerfiles, infra-as-code, secrets) that doesn't belong next to a
client library's source; (c) an external community forms around just the
binjson codec.

## Open questions worth deciding explicitly

- **Cloud service wire protocol** — thin custom API (recommended) vs. real
  MongoDB wire-protocol compatibility (much larger scope) — depends on
  whether "drop-in for the `mongodb` npm driver, unmodified" is an actual
  requirement or a nice-to-have.
- **How much of the web-use-case gap list (TypeScript types, IndexedDB
  fallback, slimmed WASM build, CI) to do before vs. after starting the
  native work** — they're independent efforts and could run in parallel if
  there's more than one pair of hands, or need explicit sequencing if not.
