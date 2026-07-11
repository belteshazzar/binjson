/**
 * Block-partitioned postings tests (C_DATABASE_REVIEW.md §4.2).
 *
 * The C text index stores each term's posting list as fixed-capacity blocks
 * ("term\0" header + "term\0<hex>" blocks) so adding a document rewrites one
 * bounded block instead of the whole list — the legacy single-blob layout
 * appended O(d²) total bytes for a term matching d documents. The legacy
 * layout (what the pure-JS implementation writes) is still read transparently
 * and migrated to blocks the first time a term is written.
 *
 * These tests pin the file-growth behavior, the legacy-read/migrate path
 * (C opening JS-written index files), and that observable semantics —
 * including re-adding documents whose entries live in old blocks — stay
 * identical to the JS reference.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ready, TextIndex, BPlusTree } from '../src/binjson-wasm.js';
import { TextIndex as TextIndexJS } from '../src/textindex.js';
import { BPlusTree as BPlusTreeJS } from '../src/bplustree.js';
import { deleteFile, getFileHandle } from '../src/binjson.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

describe.skipIf(!hasOPFS)('WASM TextIndex block-partitioned postings', () => {
  let root = null;
  let counter = 0;

  beforeAll(async () => {
    root = await navigator.storage.getDirectory();
  });

  const files = [];
  const base = () => `test-tixblocks-${Date.now()}-${counter++}`;

  afterAll(async () => {
    for (const f of files) await deleteFile(root, f);
  });

  async function makeIndex(Index, Tree, name) {
    async function tree(suffix) {
      const filename = `${name}-${suffix}.bj`;
      files.push(filename);
      const fh = await getFileHandle(root, filename, { create: true });
      return new Tree(await fh.createSyncAccessHandle(), 16);
    }
    const idx = new Index({
      order: 16,
      trees: {
        index: await tree('terms'),
        documentTerms: await tree('documents'),
        documentLengths: await tree('lengths')
      }
    });
    await idx.open();
    return idx;
  }

  async function fileSize(filename) {
    const fh = await getFileHandle(root, filename, { create: false });
    const h = await fh.createSyncAccessHandle();
    const n = h.getSize();
    h.close();
    return n;
  }

  const docText = (i) => `shared common corpus unique${i}x group${i % 10}`;

  it('terms file grows linearly, not quadratically, on shared terms', async () => {
    const name = base();
    const idx = await makeIndex(TextIndex, BPlusTree, name);
    const N = 600;
    for (let i = 0; i < N / 2; i++) await idx.add(`doc-${i}`, docText(i));
    await idx.close();
    const half = await fileSize(`${name}-terms.bj`);

    const reopened = await makeIndex(TextIndex, BPlusTree, name);
    for (let i = N / 2; i < N; i++) await reopened.add(`doc-${i}`, docText(i));
    await reopened.close();
    const full = await fileSize(`${name}-terms.bj`);

    // Linear growth: the second half costs about as much as the first.
    // The legacy layout rewrote every shared term's whole list per add,
    // making the second half ~3x the first (quadratic cumulative bytes).
    expect(full / half).toBeLessThan(2.4);

    // And it must actually beat the legacy layout on total bytes.
    const legacyName = base();
    const legacy = await makeIndex(TextIndexJS, BPlusTreeJS, legacyName);
    for (let i = 0; i < N; i++) await legacy.add(`doc-${i}`, docText(i));
    await legacy.close();
    const legacySize = await fileSize(`${legacyName}-terms.bj`);
    expect(full).toBeLessThan(legacySize / 2);
  }, 90000);   // the legacy comparison index is slow to build under full-suite load

  it('reads JS-written (legacy) index files and migrates on write', async () => {
    const name = base();
    const js = await makeIndex(TextIndexJS, BPlusTreeJS, name);
    for (let i = 0; i < 60; i++) await js.add(`doc-${i}`, docText(i));
    await js.close();

    // Same files, WASM implementation: legacy blobs are read directly.
    const idx = await makeIndex(TextIndex, BPlusTree, name);
    let hits = await idx.query('shared');
    expect(hits.length).toBe(60);
    expect(await idx.query('unique7x', { scored: false })).toEqual(['doc-7']);
    expect(await idx.getDocumentCount()).toBe(60);

    // Writing migrates the touched terms to blocks; everything stays visible.
    for (let i = 60; i < 90; i++) await idx.add(`doc-${i}`, docText(i));
    hits = await idx.query('shared');
    expect(hits.length).toBe(90);
    expect(await idx.query('unique7x', { scored: false })).toEqual(['doc-7']);

    // Removing a JS-era doc reaches it through the migrated blocks.
    expect(await idx.remove('doc-7')).toBe(true);
    expect(await idx.query('unique7x')).toHaveLength(0);
    expect((await idx.query('shared')).length).toBe(89);
    expect(await idx.getTermCount()).toBeGreaterThan(0);
    await idx.close();
  });

  it('matches the JS reference when docs are re-added across block boundaries', async () => {
    const name = base();
    const wasm = await makeIndex(TextIndex, BPlusTree, `${name}-w`);
    const js = await makeIndex(TextIndexJS, BPlusTreeJS, `${name}-j`);

    // doc-0 lands in block 0; 50 more docs push the active block past it;
    // then doc-0 is re-added with a different tf for "shared".
    const ops = [['doc-0', 'shared once']];
    for (let i = 1; i <= 50; i++) ops.push([`doc-${i}`, docText(i)]);
    ops.push(['doc-0', 'shared shared shared thrice']);
    for (const [id, text] of ops) {
      await wasm.add(id, text);
      await js.add(id, text);
    }

    expect(await wasm.getDocumentCount()).toBe(51);
    const a = await wasm.query('shared');
    const b = await js.query('shared');
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    for (let i = 0; i < a.length; i++) expect(a[i].score).toBeCloseTo(b[i].score, 10);
    // doc-0 appears exactly once despite entries in two blocks.
    expect(a.filter((r) => r.id === 'doc-0').length).toBe(1);

    // Removing doc-0 clears both entries.
    await wasm.remove('doc-0');
    await js.remove('doc-0');
    const a2 = await wasm.query('shared');
    const b2 = await js.query('shared');
    expect(a2.some((r) => r.id === 'doc-0')).toBe(false);
    expect(a2.map((r) => r.id)).toEqual(b2.map((r) => r.id));
    await wasm.close();
    await js.close();
  });

  it('deletes a term chain when its last document is removed', async () => {
    const idx = await makeIndex(TextIndex, BPlusTree, base());
    await idx.add('doc-a', 'ephemeral zebra');
    await idx.add('doc-b', 'zebra');
    const terms = await idx.getTermCount();
    expect(await idx.remove('doc-a')).toBe(true);
    // "ephemeral" chain fully deleted; "zebra" survives.
    expect(await idx.getTermCount()).toBe(terms - 1);
    expect(await idx.query('ephemeral')).toHaveLength(0);
    expect((await idx.query('zebra', { scored: false }))).toEqual(['doc-b']);
    await idx.close();
  });
});
