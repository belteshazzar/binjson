import { BPlusTree } from '../src/bplustree.js';
import { BinJsonFile } from '../src/binjson.js';

// Provide OPFS in Node using node-opfs (installed as devDependency)
const nodeOpfs = await import('node-opfs');
Object.defineProperty(global, 'navigator', {
  value: nodeOpfs.navigator,
  writable: true,
  configurable: true
});

// Helper to clean up a binjson file if it exists
async function cleanup(filename) {
  const file = new BinJsonFile(filename);
  if (await file.exists()) {
    await file.open('rw');
    await file.delete();
  }
}

// Simple demo runner
async function main() {
  const filename = 'demo-bplustree.bj';
  const compactedFilename = 'demo-bplustree-compacted.bj';

  await cleanup(filename);
  await cleanup(compactedFilename);

  // Create and open the tree
  const tree = new BPlusTree(filename, 4);
  await tree.open();

  // Insert a few key/value pairs
  await tree.add('alpha', { id: 1, label: 'first' });
  await tree.add('beta', { id: 2, label: 'second' });
  await tree.add('gamma', { id: 3, label: 'third' });

  // Show current contents
  const before = await tree.toArray();
  console.log('Original tree entries:', before);

  // Compact to a new file
  const result = await tree.compact(compactedFilename);
  console.log('Compaction result:', result);

  // Close original tree
  await tree.close();

  // Open the compacted tree and show its contents
  const compacted = new BPlusTree(compactedFilename, 4);
  await compacted.open();
  const after = await compacted.toArray();
  console.log('Compacted tree entries:', after);
  await compacted.close();

  // Optional: clean up files at the end
  // await cleanup(filename);
  // await cleanup(compactedFilename);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
