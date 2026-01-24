import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { encode, ObjectId, Pointer } from '../src/binjson.js';

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

function runCli(filePath) {
  return new Promise((resolve, reject) => {
    execFile('node', ['bin/binjson-decode.js', filePath], { cwd: process.cwd() }, (error, stdout, stderr) => {
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

describe('binjson-decode CLI', () => {
  it('decodes Pointer, ObjectId, and Date with readable formatting', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'binjson-decode-'));
    const filePath = join(tempDir, 'sample.bj');

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

    await writeFile(filePath, fileData);

    const { stdout } = await runCli(filePath);

    expect(stdout).toContain('Pointer(1234)');
    expect(stdout).toContain('Pointer(99)');
    expect(stdout).toContain('ObjectId(5f1d7f3a0b0c0d0e0f101112)');
    expect(stdout).toContain('ObjectId(6a6b6c6d6e6f707172737475)');
    expect(stdout).toContain('Date(2020-01-02T03:04:05.000Z)');
    expect(stdout).toContain('Date(2021-01-01T00:00:00.000Z)');
    // Ensure nested structures are rendered across lines
    expect(stdout).toContain('@ 0 (64 bytes, entry: 0)');
    expect(stdout).toMatch(/@ 64 \(40 bytes, entry: 1\)/);
  });
});
