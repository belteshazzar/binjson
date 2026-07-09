import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { encode, ObjectId, Pointer, deleteFile, getFileHandle } from '../src/binjson.js';

// Set up node-opfs for Node.js environment
let hasOPFS = false;
let rootDirHandle = null;
let testFileCounter = 0;

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

if (hasOPFS) {
  beforeAll(async () => {
    if (navigator.storage && navigator.storage.getDirectory) {
      rootDirHandle = await navigator.storage.getDirectory();
    }
  });
}

function concatBuffers(buffers) {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

// Write raw binjson bytes to an OPFS file and return its name, so the CLI (which
// reads through OPFS) can open it.
async function writeOpfsFile(bytes) {
  const filename = `test-binjson-decode-${Date.now()}-${testFileCounter++}.bj`;
  const fileHandle = await getFileHandle(rootDirHandle, filename, { create: true });
  const syncHandle = await fileHandle.createSyncAccessHandle();
  syncHandle.write(bytes, { at: 0 });
  await syncHandle.close();
  return filename;
}

function runCli(filePath) {
  return new Promise((resolve, reject) => {
    execFile('node', ['bin/binjson.js', filePath], { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

describe.skipIf(!hasOPFS)('binjson-decode CLI', () => {
  it('decodes Pointer, ObjectId, and Date with readable formatting', async () => {
    const oid1 = new ObjectId('5f1d7f3a0b0c0d0e0f101112');
    const oid2 = new ObjectId('6a6b6c6d6e6f707172737475');
    const date1 = new Date('2020-01-02T03:04:05.000Z');
    const date2 = new Date('2021-01-01T00:00:00.000Z');

    const value1 = {
      id: oid1,
      created: date1,
      ref: new Pointer(1234)
    };

    const value2 = [new Pointer(99), oid2, date2];

    const fileData = concatBuffers([
      encode(value1),
      encode(value2)
    ]);

    const filename = await writeOpfsFile(fileData);

    let stdout;
    try {
      ({ stdout } = await runCli(filename));
    } finally {
      await deleteFile(rootDirHandle, filename);
    }

    expect(stdout).toContain('Pointer(1234)');
    expect(stdout).toContain('Pointer(99)');
    expect(stdout).toContain('ObjectId(5f1d7f3a0b0c0d0e0f101112)');
    expect(stdout).toContain('ObjectId(6a6b6c6d6e6f707172737475)');
    expect(stdout).toContain('Date(2020-01-02T03:04:05.000Z)');
    expect(stdout).toContain('Date(2021-01-01T00:00:00.000Z)');
    // Each record is prefixed with its byte offset and size in the file.
    expect(stdout).toContain('@ 0 (64 bytes, entry: 0)');
    expect(stdout).toMatch(/@ 64 \(40 bytes, entry: 1\)/);
  });
});
