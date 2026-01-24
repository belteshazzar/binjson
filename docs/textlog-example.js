/**
 * TextLog Example - Version Control for Text Documents
 * 
 * This example demonstrates how to use TextLog to:
 * - Store multiple versions of a text document
 * - Retrieve any version
 * - Generate human-readable diffs between versions
 */

import { TextLog } from '../src/textlog.js';
import { getFileHandle, deleteFile } from '../src/bjson.js';

// Set up node-opfs for Node.js environment
async function setupOPFS() {
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
    console.error('Failed to load node-opfs. This example requires OPFS support.');
    throw e;
  }
}

async function main() {
  // Setup OPFS for Node.js
  await setupOPFS();

  console.log('TextLog Example\n');

  // Get OPFS directory and create/open file
  const dirHandle = await navigator.storage.getDirectory();
  const fileHandle = await getFileHandle(dirHandle, 'example-textlog.bjson', { create: true });
  const syncHandle = await fileHandle.createSyncAccessHandle();

  // Create a new TextLog with 3 diffs between snapshots
  const log = new TextLog(syncHandle, 3);
  await log.open();

  console.log('Adding versions...\n');

  // Add version 1
  const text1 = `Chapter 1: Introduction
This is the beginning of our story.
It was a dark and stormy night.`;
  await log.addVersion(text1);
  console.log('Added version 1');

  // Add version 2 - minor edit
  const text2 = `Chapter 1: Introduction
This is the beginning of our amazing story.
It was a dark and stormy night.`;
  await log.addVersion(text2);
  console.log('Added version 2');

  // Add version 3 - more changes
  const text3 = `Chapter 1: Introduction
This is the beginning of our amazing story.
It was a dark and stormy night.

Chapter 2: The Adventure Begins
Our hero sets out on a journey.`;
  await log.addVersion(text3);
  console.log('Added version 3');

  // Add version 4 - another edit (triggers snapshot)
  const text4 = `Chapter 1: Introduction
This is the beginning of our amazing story.
It was a dark and stormy night in October.

Chapter 2: The Adventure Begins
Our hero sets out on an epic journey.`;
  await log.addVersion(text4);
  console.log('Added version 4 (new snapshot)\n');

  // Retrieve a specific version
  console.log('=== Retrieving Version 2 ===');
  const retrievedText = await log.getVersion(2);
  console.log(retrievedText);
  console.log();

  // Get hash of a version
  const hash2 = await log.getVersionHash(2);
  console.log(`Hash of version 2: ${hash2.substring(0, 16)}...\n`);

  // Generate a diff between two versions
  console.log('=== Diff from Version 1 to Version 3 ===');
  const diff13 = await log.getDiff(1, 3);
  console.log(diff13);

  console.log('=== Diff from Version 2 to Version 4 ===');
  const diff24 = await log.getDiff(2, 4);
  console.log(diff24);

  // Current version
  console.log(`Current version: ${log.getCurrentVersion()}`);

  await log.close();
  await syncHandle.close();
  await deleteFile(dirHandle, 'example-textlog.bjson');
  console.log('\nTextLog closed successfully');
}

main().catch(console.error);
