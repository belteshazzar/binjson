import { TextIndex } from '../src/textindex.js';
import { BJsonFile } from '../src/binjson.js';

// Provide OPFS in Node using node-opfs (installed as devDependency)
const nodeOpfs = await import('node-opfs');
Object.defineProperty(global, 'navigator', {
  value: nodeOpfs.navigator,
  writable: true,
  configurable: true
});

async function cleanupBase(name) {
  const files = [
    `${name}-terms.bj`,
    `${name}-documents.bj`,
    `${name}-lengths.bj`
  ];

  for (const file of files) {
    const handle = new BJsonFile(file);
    if (await handle.exists()) {
      await handle.open('rw');
      await handle.delete();
    }
  }
}

async function main() {
  const baseName = 'demo-text-index';
  const compactBase = 'demo-text-index-compacted';

  await cleanupBase(baseName);
  await cleanupBase(compactBase);

  const index = new TextIndex({ baseFilename: baseName, order: 8 });
  await index.open();

  await index.add('doc1', 'The quick brown fox jumps over the lazy dog');
  await index.add('doc2', 'Lazy dogs nap in the sun');
  await index.add('doc3', 'A fast fox outruns every dog in the park');

  const before = await index.query('fox dog', { scored: false });
  console.log('Before compaction (fox dog):', before);

  const result = await index.compact(compactBase);
  console.log('Compaction result:', result);

  const after = await index.query('fox dog', { scored: false });
  console.log('After compaction (fox dog):', after);

  await index.add('doc4', 'Foxes and dogs share the trail');
  const post = await index.query('fox', { scored: false });
  console.log('After compaction, fox query with new doc:', post);

  await index.close();

  // Optional: clean up files at the end
  // await cleanupBase(baseName);
  // await cleanupBase(compactBase);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
