#!/usr/bin/env node
import { RTree } from '../src/rtree.js';

// Set up node-opfs for Node.js environment
try {
  const nodeOpfs = await import('node-opfs');
  if (nodeOpfs.navigator && typeof global !== 'undefined') {
    Object.defineProperty(global, 'navigator', {
      value: nodeOpfs.navigator,
      writable: true,
      configurable: true
    });
  }
} catch (e) {
  console.error('Error: node-opfs is required to run this tool in Node.js');
  console.error('Install it with: npm install node-opfs');
  process.exit(1);
}

function usage() {
  console.error('Usage: rtree-compact <source.bj> <destination.bj>');
  console.error('');
  console.error('Compacts an R-tree file by copying only the latest version of nodes');
  console.error('to a new file, removing obsolete node versions and reclaiming space.');
  process.exit(1);
}

async function main() {
  const sourceFile = process.argv[2];
  const destFile = process.argv[3];

  if (!sourceFile || !destFile) {
    usage();
  }

  if (sourceFile === destFile) {
    console.error('Error: Source and destination files must be different');
    process.exit(1);
  }

  let tree;
  try {
    console.log(`Opening source file: ${sourceFile}`);
    tree = new RTree(sourceFile);
    await tree.open();

    console.log(`Compacting to: ${destFile}`);
    const result = await tree.compact(destFile);

    console.log('');
    console.log('Compaction complete!');
    console.log(`  Original size: ${result.oldSize} bytes`);
    console.log(`  Compacted size: ${result.newSize} bytes`);
    console.log(`  Space saved: ${result.bytesSaved} bytes (${((result.bytesSaved / result.oldSize) * 100).toFixed(2)}%)`);

    await tree.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (tree && tree.isOpen) {
      await tree.close();
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
