import { describe, it, beforeEach, afterEach, expect, beforeAll } from 'vitest';
import { TextIndex } from '../src/textindex.js';
import { BPlusTree } from '../src/bplustree.js';
import { deleteFile, getFileHandle } from '../src/binjson.js';

let hasOPFS = false;
try {
  const nodeOpfs = await import('node-opfs');
  if (nodeOpfs.navigator && typeof global !== 'undefined') {
    Object.defineProperty(global, 'navigator', {
      value: nodeOpfs.navigator,
      writable: true,
      configurable: true
    });
    hasOPFS = true;
  }
} catch (e) {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
    hasOPFS = true;
  }
}

describe.skipIf(!hasOPFS)('TextIndex compaction', function() {
  let index;
  let baseName;
  let compactBase;
  let counter = 0;
  let rootDirHandle = null;

  beforeAll(async () => {
    if (navigator.storage && navigator.storage.getDirectory) {
      rootDirHandle = await navigator.storage.getDirectory();
    }
  });

  async function cleanupFiles(name) {
    if (!name) return;
    const files = [
      `${name}-terms.bj`,
      `${name}-documents.bj`,
      `${name}-lengths.bj`
    ];

    for (const file of files) {
        if (rootDirHandle) {
          await deleteFile(rootDirHandle, file);
        }
    }
  }

  async function createTestIndex() {
    baseName = `text-index-${Date.now()}-${counter++}`;
    
    // Create three trees with sync handles
    const indexHandle = await getFileHandle(rootDirHandle, `${baseName}-terms.bj`, { create: true });
    const indexSyncHandle = await indexHandle.createSyncAccessHandle();
    const indexTree = new BPlusTree(indexSyncHandle, 16, rootDirHandle);
    
    const docTermsHandle = await getFileHandle(rootDirHandle, `${baseName}-documents.bj`, { create: true });
    const docTermsSyncHandle = await docTermsHandle.createSyncAccessHandle();
    const docTermsTree = new BPlusTree(docTermsSyncHandle, 16, rootDirHandle);
    
    const lengthsHandle = await getFileHandle(rootDirHandle, `${baseName}-lengths.bj`, { create: true });
    const lengthsSyncHandle = await lengthsHandle.createSyncAccessHandle();
    const lengthsTree = new BPlusTree(lengthsSyncHandle, 16, rootDirHandle);
    
    const idx = new TextIndex({
      order: 16,
      trees: {
        index: indexTree,
        documentTerms: docTermsTree,
        documentLengths: lengthsTree
      }
    });
    
    return idx;
  }

  beforeEach(async function() {
    compactBase = null;
    index = await createTestIndex();
    await index.open();
  });

  afterEach(async function() {
    if (index) {
      await index.close();
      index = null;
    }

    await cleanupFiles(baseName);
    await cleanupFiles(compactBase);
  });

  it('compacts underlying trees and keeps queries working', async function() {
    await index.add('doc1', 'The quick brown fox jumps');
    await index.add('doc2', 'Lazy dogs nap all day');

    const before = await index.query('quick fox', { scored: false });
    expect(before).toContain('doc1');

    compactBase = `${baseName}-compact`;
    
    // Create destination trees for compaction (unopened, with fresh sync handles)
    const indexHandle = await getFileHandle(rootDirHandle, `${compactBase}-terms.bj`, { create: true });
    const indexSyncHandle = await indexHandle.createSyncAccessHandle();
    const destIndexTree = new BPlusTree(indexSyncHandle, 16);
    
    const docTermsHandle = await getFileHandle(rootDirHandle, `${compactBase}-documents.bj`, { create: true });
    const docTermsSyncHandle = await docTermsHandle.createSyncAccessHandle();
    const destDocTermsTree = new BPlusTree(docTermsSyncHandle, 16);
    
    const lengthsHandle = await getFileHandle(rootDirHandle, `${compactBase}-lengths.bj`, { create: true });
    const lengthsSyncHandle = await lengthsHandle.createSyncAccessHandle();
    const destLengthsTree = new BPlusTree(lengthsSyncHandle, 16);
    
    // Perform compaction
    const result = await index.compact({
      index: destIndexTree,
      documentTerms: destDocTermsTree,
      documentLengths: destLengthsTree
    });

    // Verify compaction results
    expect(result.terms.oldSize).toBeGreaterThan(0);
    expect(result.documents.oldSize).toBeGreaterThan(0);
    expect(result.lengths.oldSize).toBeGreaterThan(0);

    // Compaction closes the index, so we need to reopen with the compacted data
    const indexHandle2 = await getFileHandle(rootDirHandle, `${compactBase}-terms.bj`, { create: false });
    const indexSyncHandle2 = await indexHandle2.createSyncAccessHandle();
    const compactedIndex = new BPlusTree(indexSyncHandle2, 16);
    
    const docTermsHandle2 = await getFileHandle(rootDirHandle, `${compactBase}-documents.bj`, { create: false });
    const docTermsSyncHandle2 = await docTermsHandle2.createSyncAccessHandle();
    const compactedDocTerms = new BPlusTree(docTermsSyncHandle2, 16);
    
    const lengthsHandle2 = await getFileHandle(rootDirHandle, `${compactBase}-lengths.bj`, { create: false });
    const lengthsSyncHandle2 = await lengthsHandle2.createSyncAccessHandle();
    const compactedLengths = new BPlusTree(lengthsSyncHandle2, 16);
    
    index = new TextIndex({
      order: 16,
      trees: {
        index: compactedIndex,
        documentTerms: compactedDocTerms,
        documentLengths: compactedLengths
      }
    });
    
    await index.open();

    // Verify data is still accessible after compaction
    const after = await index.query('quick fox', { scored: false });
    expect(after).toEqual(expect.arrayContaining(before));
    expect(await index.getDocumentCount()).toBe(2);

    // Verify we can still add data to the compacted index
    await index.add('doc3', 'quick dogs and foxes together');
    const post = await index.query('dogs', { scored: false });
    expect(post).toContain('doc3');
  });
});
