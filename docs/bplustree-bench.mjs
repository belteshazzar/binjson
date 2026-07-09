/**
 * B+ tree parity + durability + performance benchmark:
 *   - pure-JS   src/bplustree.js       (write-through per op)
 *   - WASM      src/binjson-wasm.js     (write-through per op)
 *
 * Both are durable: every mutation is persisted before it returns.
 *
 *   1. Parity: identical deterministic workload through each; every observable
 *      output (sizes, heights, searches, ranges, toArray, iteration) must match.
 *   2. Durability: instruments the file handle to show how many bytes each
 *      writes to disk *during* mutations vs *at close* (crash-safety).
 *   3. Performance: times each operation category and prints a table.
 *
 * Run:  node bench/bplustree-bench.mjs [scale]   (scale = key count, default 2000)
 */
import assert from 'node:assert';
import { navigator as nodeNavigator } from 'node-opfs';
Object.defineProperty(global, 'navigator', { value: nodeNavigator, writable: true, configurable: true });

import { BPlusTree as JsTree } from '../src/bplustree.js';
import { ready as wasmReady, BPlusTree as WasmTree } from '../src/binjson-wasm.js';
import { getFileHandle, deleteFile } from '../src/binjson.js';

await wasmReady();
const root = await navigator.storage.getDirectory();

let fileCounter = 0;
const liveFiles = new Set();

/** Wrap a sync handle's write() to tally bytes written per phase (op vs close). */
function instrumentHandle(sh) {
  const stats = { phase: 'op', opCalls: 0, opBytes: 0, closeCalls: 0, closeBytes: 0 };
  const realWrite = sh.write.bind(sh);
  sh.write = (buf, opts) => {
    const n = (buf && (buf.byteLength ?? buf.length)) || 0;
    if (stats.phase === 'close') { stats.closeCalls++; stats.closeBytes += n; }
    else { stats.opCalls++; stats.opBytes += n; }
    return realWrite(buf, opts);
  };
  return stats;
}

async function openTree(TreeClass, order, { instrument = false } = {}) {
  const filename = `bench-${Date.now()}-${fileCounter++}.bj`;
  liveFiles.add(filename);
  const fh = await getFileHandle(root, filename, { create: true });
  const sh = await fh.createSyncAccessHandle();
  const stats = instrument ? instrumentHandle(sh) : null;
  const tree = new TreeClass(sh, order);
  tree.__file = filename;
  tree.__stats = stats;
  await tree.open();
  return tree;
}
async function dropTree(tree) {
  if (tree.isOpen) await tree.close();
  if (tree.__file) { await deleteFile(root, tree.__file).catch(() => {}); liveFiles.delete(tree.__file); }
}

/* Deterministic PRNG so every variant sees identical workloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(n, seed) {
  const rng = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function valueFor(k) {
  if (k % 3 === 0) return `str-${k}`;
  if (k % 3 === 1) return { key: k, label: `n${k}`, ok: k % 2 === 0, tags: [k, k + 1] };
  return [k, `${k}`, { nested: { v: k } }];
}

/* ---- Parity --------------------------------------------------------- */

async function collectOutputs(TreeClass, order, n, seed) {
  const tree = await openTree(TreeClass, order);
  const out = {};
  for (const k of shuffled(n, seed)) await tree.add(k, valueFor(k));
  out.sizeAfterInsert = tree.size();
  out.height = await tree.getHeight();

  const searches = [];
  for (let k = 0; k < n; k++) searches.push(await tree.search(k));
  for (const miss of [-1, n, n + 5, 10 ** 9]) searches.push(await tree.search(miss));
  out.searches = searches;

  const ranges = [];
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = 0; i < 25; i++) {
    const lo = Math.floor(rng() * n);
    const hi = lo + Math.floor(rng() * (n / 4));
    ranges.push((await tree.rangeSearch(lo, hi)).map(e => e.key));
  }
  out.ranges = ranges;
  out.toArray = await tree.toArray();

  const iterated = [];
  for await (const e of tree) iterated.push(e);
  out.iterated = iterated;

  for (let k = 0; k < n; k += 3) await tree.delete(k);
  out.sizeAfterDelete = tree.size();
  const postDelete = [];
  for (let k = 0; k < n; k++) postDelete.push(await tree.search(k));
  out.postDeleteSearches = postDelete;
  out.toArrayAfterDelete = (await tree.toArray()).map(e => e.key);

  await dropTree(tree);
  return out;
}

async function runParity() {
  console.log('== Parity check (all variants produce identical results) ==');
  const cases = [
    { order: 3, n: 400, seed: 1 },
    { order: 4, n: 600, seed: 2 },
    { order: 7, n: 750, seed: 3 },
  ];
  for (const c of cases) {
    const js = await collectOutputs(JsTree, c.order, c.n, c.seed);
    const wasm = await collectOutputs(WasmTree, c.order, c.n, c.seed);
    assert.deepStrictEqual(wasm, js, `mismatch order=${c.order}`);
    console.log(`  order=${c.order} n=${c.n}: OK  (size=${js.sizeAfterInsert}, height=${js.height}, afterDelete=${js.sizeAfterDelete})`);
  }
  console.log('  ✓ JS == WASM\n');
}

/* ---- Durability demonstration --------------------------------------- */

async function runDurability(m = 400) {
  console.log(`== Durability (bytes hitting the file during ${m} adds + deletes vs at close) ==`);
  const variants = [
    ['JS', JsTree],
    ['WASM', WasmTree],
  ];
  console.log('  variant           | during ops (writes) |  at close (writes) | reopened size');
  console.log('  ------------------|---------------------|--------------------|--------------');
  for (const [label, TreeClass] of variants) {
    const tree = await openTree(TreeClass, 8, { instrument: true });
    const stats = tree.__stats;
    for (let i = 0; i < m; i++) await tree.add(i, valueFor(i));
    for (let i = 0; i < m; i += 4) await tree.delete(i);
    stats.phase = 'close';
    const filename = tree.__file;
    liveFiles.delete(filename);
    if (tree.isOpen) await tree.close();

    // Reopen from disk to confirm the data actually persisted.
    const fh = await getFileHandle(root, filename, { create: false });
    const sh = await fh.createSyncAccessHandle();
    const reopened = new TreeClass(sh, 8);
    await reopened.open();
    const size = reopened.size();
    await reopened.close();
    await deleteFile(root, filename).catch(() => {});

    const ops = `${(stats.opBytes / 1024).toFixed(1)} KB (${stats.opCalls})`.padStart(19);
    const close = `${(stats.closeBytes / 1024).toFixed(1)} KB (${stats.closeCalls})`.padStart(18);
    console.log(`  ${label.padEnd(17)} | ${ops} | ${close} | ${String(size).padStart(12)}`);
  }
  console.log('  (write-through variants persist during ops => crash-safe before close)\n');
}

/* ---- Performance ---------------------------------------------------- */

const now = () => Number(process.hrtime.bigint()) / 1e6;
const N_RANGES = 500;
const N_TOARRAY = 40;

async function timeInsert(TreeClass, keys) {
  const tree = await openTree(TreeClass, 16);
  const t0 = now();
  for (const k of keys) await tree.add(k, valueFor(k));
  return { tree, ms: now() - t0 };
}

async function benchImpl(TreeClass, n) {
  const insertKeys = shuffled(n, 12345);
  const { tree, ms: insertMs } = await timeInsert(TreeClass, insertKeys);

  const searchKeys = shuffled(n, 999);
  let t0 = now();
  for (const k of searchKeys) tree.search(k);
  const searchMs = now() - t0;

  const rng = mulberry32(777);
  t0 = now();
  for (let i = 0; i < N_RANGES; i++) tree.rangeSearch(Math.floor(rng() * n), Math.floor(rng() * n) + 50);
  const rangeMs = now() - t0;

  t0 = now();
  for (let i = 0; i < N_TOARRAY; i++) tree.toArray();
  const toArrayMs = now() - t0;

  const { tree: delTree } = await timeInsert(TreeClass, insertKeys);
  const delKeys = shuffled(n, 54321).slice(0, Math.floor(n / 2));
  t0 = now();
  for (const k of delKeys) delTree.delete(k);
  const deleteMs = now() - t0;

  await dropTree(tree);
  await dropTree(delTree);
  return { insert: insertMs, search: searchMs, range: rangeMs, toArray: toArrayMs, delete: deleteMs,
    counts: { insert: n, search: n, range: N_RANGES, toArray: N_TOARRAY, delete: delKeys.length } };
}

const pad = (s, w) => String(s).padStart(w);
async function runPerf(n) {
  console.log(`== Performance (n=${n} keys) ==`);
  await benchImpl(JsTree, 80).catch(() => {});       // warm up
  await benchImpl(WasmTree, 80).catch(() => {});

  const js = await benchImpl(JsTree, n);
  const wasm = await benchImpl(WasmTree, n);

  const rows = ['insert', 'search', 'range', 'toArray', 'delete'];
  console.log('');
  console.log('  operation   |    JS (ms) |  WASM (ms) | speedup');
  console.log('  ------------|------------|------------|--------');
  for (const r of rows) {
    console.log(`  ${r.padEnd(11)} | ${pad(js[r].toFixed(1), 10)} | ${pad(wasm[r].toFixed(1), 10)} | ` +
      `${pad((js[r] / wasm[r]).toFixed(1) + 'x', 6)}`);
  }
  console.log('');
}

/* ---- Main ----------------------------------------------------------- */

try {
  const scale = Number(process.argv[2]) || 2000;
  await runParity();
  await runDurability(400);
  await runPerf(scale);
} finally {
  for (const f of liveFiles) await deleteFile(root, f).catch(() => {});
}
