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
- **macOS/iOS: compile the C core natively, don't embed a JS engine.**
  Decided (not just leaning): no JavaScriptCore/WASM embedding. The C code
  already builds and runs as plain, portable C11 (`npm run test:c` proves
  this every milestone), and the host I/O boundary (`c/bjio.h`) was
  *already designed* for this — its own doc comment says "plain file
  descriptors in a native build." This is far less new work than it
  sounds, and it's the better runtime/binary-size outcome. See
  [Use case 2](#use-case-2-macosios-app-embedding).
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
  `FileSystemSyncAccessHandle`) and its own comment already anticipates a
  second, native implementation. This is the single most important existing
  asset for use case 2.
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

### Decision: native C compile, no WASM, no JS engine

Compile `c/db*.c`, `c/binjson.c`, `c/bplustree.c` etc. directly as a native
static library/XCFramework (arm64 + x86_64), skip the `*_wasm.c` glue files
entirely (they only exist to satisfy Emscripten's WASM-export ABI
conventions — a native Swift bridge calls the underlying `dc_*`/`bj_*`
functions directly with native pointers), and write a Swift package that
wraps the C API. The one new C-side piece is a native `bj_io`
implementation (`c/hostio.c`'s WASM version is ~40 lines of `EM_JS`; a
POSIX `pread`/`pwrite`/`ftruncate`/`fstat`-backed native version is
comparably small — and `bjio.h`'s own comment already names this as the
intended second implementation).

The alternative considered — bundling `lib/binjson.wasm` + the existing JS
glue and running it inside a `JSContext` (JavaScriptCore ships on both
macOS and iOS as a system framework, no App-Store engine restriction) —
would reuse the JS `Collection` API as-is and needs less new code (just a
Swift-side `StorageProvider` bridge and a thin Swift-to-JS facade). Ruled
out in favor of the native path because:
- The C core is *already proven* to build natively (every milestone's own
  verification step does this) — there's no unknown here, just an unwritten
  `bj_io` backend.
- No JS engine startup/runtime overhead, no WASM interpretation/JIT tax —
  meaningfully better for a mobile-embedded database where binary size and
  battery/CPU headroom both matter.
- Swift's C interop (via a Swift Package Manager C target) is a mature,
  well-trodden path; JSContext-based WASM embedding is comparatively exotic
  and has less community precedent to lean on if something goes wrong.
- It keeps the "C owns all the logic" rule (already the project's own
  stated architecture principle) literally true for a third consumer, not
  just figuratively — the Swift layer is exactly as thin a bridge as
  `binjson-wasm.js` is today, just calling C directly instead of through a
  WASM boundary.

The honest cost: someone has to write the Swift-facing binjson encoder/
decoder and `Db`/`Collection` API wrapper (the Swift counterpart to
`binjson-wasm.js`) from scratch — real, non-trivial new code. That cost
exists either way (the JSC path needs an equivalent Swift-JS bridge), so
it isn't a reason to prefer the alternative — it's just the acknowledged
price of this use case, independent of which path is chosen.

### Other requirements
- **Storage location**: the app's own sandboxed container (`Application
  Support`/`Documents`), not OPFS — this is exactly what the native `bj_io`
  (Option B) or a Swift `StorageProvider` (Option A) replaces.
- **No `navigator.locks`/`BroadcastChannel` equivalent needed for a single
  app process** — `src/db-coordinator.js`'s multi-tab problem doesn't exist
  inside one app's process. (It would resurface if a macOS app and a
  today-hypothetical Mac Catalyst/sibling process needed to share one
  database file — cross that bridge only if it comes up.)
- **App extension / background-process concurrency**: if the app has
  extensions or background tasks that might open the same database file,
  the exclusive-file-handle model that motivated `db-coordinator.js` in the
  browser applies here too, via native file locks (`flock`/`O_EXLOCK`)
  instead of Web Locks.
- **Distribution**: Swift Package Manager package wrapping the C library —
  standard, low-risk path for shipping both a compiled static library and
  a Swift API surface together.

### Steps
1. ✅ **Done.** Native `bj_io` implementation: `c/posixio.h`/`c/posixio.c`
   (POSIX `pread`/`pwrite`/`ftruncate`/`fstat`, mirroring `hostio.c`'s WASM
   shape exactly), plus `c/build-native.sh` (`npm run build:native`) —
   compiles every core source `build-wasm.sh` does, minus the `*_wasm.c`
   glue, into `lib-native/libbinjson.a` via plain `cc`/`ar`, no Emscripten.
   Verified two ways (`npm run test:native`, `c/test_posixio.c`): raw
   size/read/write/truncate correctness against a real temp file, and a
   full `bpt_create`/`bpt_add`/close/reopen/`bpt_search` round trip through
   `bplustree.c` — proving `bjio_posix` is a genuine drop-in for
   `bjio_host`, not just byte-correct in isolation. (One bug caught along
   the way: the test's own first draft passed raw C strings as B+ tree
   values; `bpt_add`'s value must be a pre-encoded binjson value since a
   node's serialized form relies on each value being self-describing —
   confirmed this wasn't a `posixio.c` bug by reproducing the identical
   failure with `fuzz.c`'s already-proven in-memory `bj_io` first.)
2. Build the C sources as an XCFramework (arm64 macOS + arm64/x86_64 iOS
   simulator + device).
3. Write the Swift-facing binjson codec (mirrors `src/binjson.js`'s
   `encode`/`decode`) and a `Db`/`Collection` Swift API (mirrors
   `src/binjson-wasm.js`'s `Db`/`Collection`), calling the C functions
   directly.
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
- **The API boundary isn't stable yet.** The macOS/iOS work above will
  likely want a different C-facing entry surface than `*_wasm.c`'s
  WASM-ABI-shaped exports (native pointers instead of malloc'd heap
  offsets, for instance). Locking in a "public, versioned, external" core
  repo API before that's been prototyped risks freezing the wrong
  boundary.
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
if one of these becomes true: (a) the native macOS/iOS work matures into
its own repo naturally because its toolchain (Xcode, SPM, XCFramework
builds) has nothing in common with the JS/Vitest/Playwright toolchain and
sharing a repo is actively getting in the way; (b) the cloud service grows
its own deploy/ops surface (Dockerfiles, infra-as-code, secrets) that
doesn't belong next to a client library's source; (c) an external
community forms around just the binjson codec.

## Open questions worth deciding explicitly

- **Cloud service wire protocol** — thin custom API (recommended) vs. real
  MongoDB wire-protocol compatibility (much larger scope) — depends on
  whether "drop-in for the `mongodb` npm driver, unmodified" is an actual
  requirement or a nice-to-have.
- **How much of the web-use-case gap list (TypeScript types, IndexedDB
  fallback, slimmed WASM build, CI) to do before vs. after starting the
  native work** — they're independent efforts and could run in parallel if
  there's more than one pair of hands, or need explicit sequencing if not.
