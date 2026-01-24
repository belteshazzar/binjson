#!/usr/bin/env node
import { BPlusTree } from '../src/bplustree.js';
import { ObjectId, Pointer, getFileHandle } from '../src/binjson.js';

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
  console.error('Usage: bplustree-decode <file.bj>');
  process.exit(1);
}

function formatValue(value) {
  const indentUnit = '  ';
  const render = (val, depth) => {
    const pad = indentUnit.repeat(depth);
    const nextPad = indentUnit.repeat(depth + 1);

    if (val === null) return 'null';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (typeof val === 'string') return JSON.stringify(val);

    if (val instanceof Pointer) {
      return `Pointer(${val.valueOf()})`;
    }

    if (val instanceof ObjectId) {
      return `ObjectId(${val.toHexString ? val.toHexString() : val.toString()})`;
    }

    if (val instanceof Date) {
      return `Date(${val.toISOString()})`;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const inner = val.map(item => `${nextPad}${render(item, depth + 1)}`).join('\n');
      return `[
${inner}
${pad}]`;
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val);
      if (entries.length === 0) return '{}';
      const inner = entries
        .map(([k, v]) => `${nextPad}${k}: ${render(v, depth + 1)}`)
        .join('\n');
      return `{
${inner}
${pad}}`;
    }

    return JSON.stringify(val);
  };

  return render(value, 0);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
  }

  let tree;
  try {
    // Get the root directory handle and file handle
    const rootDirHandle = await navigator.storage.getDirectory();
    const fileHandle = await getFileHandle(rootDirHandle, filePath, { create: false });
    const syncHandle = await fileHandle.createSyncAccessHandle();
    
    tree = new BPlusTree(syncHandle, 3, rootDirHandle, filePath);
    await tree.open();

    const entries = await tree.toArray();

    if (entries.length === 0) {
      console.log('B+ tree is empty.');
    } else {
      console.log(`B+ tree contains ${entries.length} entries:\n`);
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        console.log(`Entry ${i}:`);
        console.log(`  key: ${formatValue(entry.key)}`);
        console.log(`  value: ${formatValue(entry.value)}`);
        if (i < entries.length - 1) {
          console.log('');
        }
      }
    }

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
