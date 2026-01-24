import { BPlusTree } from '../src/bplustree.js';
import { getFileHandle, deleteFile } from '../src/bjson.js';

// Set up node-opfs for Node.js environment
const nodeOpfs = await import('node-opfs');
Object.defineProperty(global, 'navigator', {
  value: nodeOpfs.navigator,
  writable: true,
  configurable: true
});

// Get OPFS directory and create/open file
const dirHandle = await navigator.storage.getDirectory();
const fileHandle = await getFileHandle(dirHandle, 'example-iterator.bjson', { create: true });
const syncHandle = await fileHandle.createSyncAccessHandle();

// Create and populate a tree
const tree = new BPlusTree(syncHandle, 3);
await tree.open();

console.log('Adding 1000 documents...');
for (let i = 0; i < 1000; i++) {
    await tree.add(i, { id: i, name: `Document ${i}`, value: Math.random() });
}

console.log('\nIterating through documents efficiently:');
let count = 0;
const startTime = Date.now();

// Use async iterator - memory efficient, loads one document at a time
for await (const entry of tree) {
    count++;
    // Process each document
    if (count <= 5 || count > 995) {
        console.log(`  Entry ${count}: key=${entry.key}, value.name=${entry.value.name}`);
    } else if (count === 6) {
        console.log('  ...');
    }
}

const endTime = Date.now();
console.log(`\nProcessed ${count} documents in ${endTime - startTime}ms`);

// Compare with toArray() - loads everything into memory at once
console.log('\nUsing toArray() for comparison:');
const arrayStartTime = Date.now();
const allDocs = tree.toArray();
const arrayEndTime = Date.now();
console.log(`Loaded ${allDocs.length} documents into array in ${arrayEndTime - arrayStartTime}ms`);

await tree.close();

// Clean up
await syncHandle.close();
await deleteFile(dirHandle, 'example-iterator.bjson');

console.log('\nDone!');
