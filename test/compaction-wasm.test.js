/**
 * C-side compaction tests (beyond the shared behavioral suite).
 *
 * bpt_compact (c/bplustree.c) rebuilds the tree with a streaming bulk load:
 * entries are packed into full nodes level by level and written straight to
 * the destination file. The output is minimal — one node per packed group,
 * one metadata record, no append-only history and no deletion cruft — which
 * these tests pin down: compacting an already-compacted tree yields an
 * identical file size, and the packed file stays readable by the pure-JS
 * implementation (it contains the durability header/trailer records).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ready, BPlusTree } from '../src/binjson-wasm.js';
import { BPlusTree as BPlusTreeJS } from '../src/bplustree.js';
import { getFileHandle } from '../src/binjson.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

describe.skipIf(!hasOPFS)('WASM B+ tree bulk-load compaction', () => {
  let root = null;
  let counter = 0;

  beforeAll(async () => {
    root = await navigator.storage.getDirectory();
  });

  const name = () => `test-compaction-${Date.now()}-${counter++}.bj`;

  async function sync(filename, create = false) {
    const fh = await getFileHandle(root, filename, { create });
    return fh.createSyncAccessHandle();
  }

  async function openTree(filename, order = 4, create = false) {
    const tree = new BPlusTree(await sync(filename, create), order);
    await tree.open();
    return tree;
  }

  it('compacts a churned tree to a fraction of its size, preserving entries', async () => {
    const src = name();
    const dst = name();
    const tree = await openTree(src, 4, true);
    for (let i = 0; i < 200; i++) tree.add(i, `value${i}`);
    for (let i = 0; i < 100; i++) tree.delete(i);           // leaves cruft
    for (let i = 0; i < 100; i += 2) tree.add(i, `again${i}`);
    const expected = tree.toArray();

    const dstHandle = await sync(dst, true);
    const { oldSize, newSize, bytesSaved } = await tree.compact(dstHandle);
    await tree.close();

    expect(newSize).toBeLessThan(oldSize / 5);
    expect(bytesSaved).toBe(oldSize - newSize);

    const packed = await openTree(dst, 4);
    expect(packed.toArray()).toEqual(expected);
    expect(packed.size()).toBe(expected.length);
    expect(packed.search(150)).toBe('value150');
    expect(packed.search(98)).toBe('again98');
    expect(packed.search(99)).toBeUndefined();              // deleted, not re-added

    // The packed tree is a normal tree: mutations keep working.
    packed.add(99, 'back');
    packed.delete(150);
    expect(packed.search(99)).toBe('back');
    expect(packed.search(150)).toBeUndefined();
    await packed.close();
  });

  it('is a fixpoint: compacting a compacted tree yields an identical size', async () => {
    const src = name();
    const dst1 = name();
    const dst2 = name();
    const tree = await openTree(src, 4, true);
    for (let i = 0; i < 300; i++) tree.add(`key-${String(i).padStart(4, '0')}`, { i });
    for (let i = 0; i < 150; i += 3) tree.delete(`key-${String(i).padStart(4, '0')}`);
    await tree.compact(await sync(dst1, true));
    await tree.close();

    const once = await openTree(dst1, 4);
    const entriesOnce = once.toArray();
    const { oldSize, newSize } = await once.compact(await sync(dst2, true));
    await once.close();

    // A bulk-loaded file contains no reclaimable bytes: recompaction is a
    // no-op size-wise (the old wrapper's rebuild-by-insertion wrote a path
    // copy plus a metadata record per entry, so it could never converge).
    expect(newSize).toBe(oldSize);

    const twice = await openTree(dst2, 4);
    expect(twice.toArray()).toEqual(entriesOnce);
    await twice.close();
  });

  it('produces a file the pure-JS implementation reads and extends', async () => {
    const src = name();
    const dst = name();
    const tree = await openTree(src, 4, true);
    for (let i = 0; i < 50; i++) tree.add(`k${i}`, { n: i });
    await tree.compact(await sync(dst, true));
    await tree.close();

    const js = new BPlusTreeJS(await sync(dst), 4);
    await js.open();
    expect(await js.search('k7')).toEqual({ n: 7 });
    expect((await js.toArray()).length).toBe(50);
    await js.add('js-added', { n: -1 });
    await js.close();

    const back = await openTree(dst, 4);
    expect(back.size()).toBe(51);
    expect(back.search('js-added')).toEqual({ n: -1 });
    await back.close();
  });

  it('compacts an empty tree', async () => {
    const src = name();
    const dst = name();
    const tree = await openTree(src, 4, true);
    tree.add('only', 1);
    tree.delete('only');
    await tree.compact(await sync(dst, true));
    await tree.close();

    const packed = await openTree(dst, 4);
    expect(packed.size()).toBe(0);
    expect(packed.isEmpty()).toBe(true);
    packed.add('fresh', 2);
    expect(packed.search('fresh')).toBe(2);
    await packed.close();
  });

  it('handles a larger tree across several packed levels', async () => {
    const src = name();
    const dst = name();
    const tree = await openTree(src, 4, true);   // order 4: many levels
    const N = 1000;
    for (let i = 0; i < N; i++) tree.add(i, `v${i}`);
    await tree.compact(await sync(dst, true));
    await tree.close();

    const packed = await openTree(dst, 4);
    expect(packed.size()).toBe(N);
    expect(packed.getHeight()).toBeGreaterThan(2);
    for (const probe of [0, 1, 499, 500, 998, 999]) {
      expect(packed.search(probe)).toBe(`v${probe}`);
    }
    const entries = packed.toArray();
    expect(entries.length).toBe(N);
    for (let i = 0; i < N; i++) expect(entries[i].key).toBe(i);  // sorted
    await packed.close();
  });
});
