/**
 * Cross-implementation interop for TextLog.
 *
 * With the diff engine ported to C byte-for-byte (c/diff.c ~ jsdiff 8.0.3) and
 * the entry/metadata records sharing the reference's binjson shapes, the JS and
 * WASM logs write the same on-disk format. These tests prove it two ways:
 *   1. A file written by one implementation is fully readable by the other
 *      (versions, hashes and getDiff all reconstruct correctly), including
 *      appending further versions with the second implementation.
 *   2. Given the same input sequence, both implementations store byte-identical
 *      entry payloads (snapshot text and DIFF patch strings) — the timestamp is
 *      the only field that differs, since it is wall-clock at write time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TextLog as TextLogJS } from '../src/textlog.js';
import { TextLog as TextLogWasm, ready } from '../src/binjson-wasm.js';
import { BinJsonFile, deleteFile, getFileHandle } from '../src/binjson.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

// A version sequence that exercises snapshots, multi-line diffs, a
// no-trailing-newline version and unicode.
const VERSIONS = [
  'Line 1\nLine 2\nLine 3\n',
  'Line 1\nLine 2 changed\nLine 3\n',
  'Line 1\nLine 2 changed\nLine 3\nLine 4\n',
  'Header\nLine 1\nLine 2 changed\nLine 3\nLine 4\n',
  'Header\nLine 1\nLine 2 changed\nLine 3\nLine 4\nLine 5\n',
  'no trailing newline here',
  'café ☕\nnaïve\n日本語\n',
  'café ☕\nNAIVE\n日本語\n'
];

describe.skipIf(!hasOPFS)('TextLog: JS <-> WASM on-disk interop', () => {
  let root = null;
  let counter = 0;

  beforeAll(async () => {
    root = await navigator.storage.getDirectory();
  });

  const name = () => `test-textlog-interop-${Date.now()}-${counter++}.bj`;

  async function open(Impl, filename, dps = 3, create = false) {
    const fh = await getFileHandle(root, filename, { create });
    const sync = await fh.createSyncAccessHandle();
    const log = new Impl(sync, dps);
    await log.open();
    return log;
  }

  async function scanEntries(filename) {
    const fh = await getFileHandle(root, filename, { create: false });
    const sync = await fh.createSyncAccessHandle();
    const file = new BinJsonFile(sync);
    const entries = [];
    for (const { value: rec } of file.scan()) {
      if (rec && (rec.type === 0x01 || rec.type === 0x02)) {
        entries.push({ type: rec.type, version: rec.version, hash: rec.hash, data: rec.data });
      }
    }
    sync.close();
    return entries;
  }

  // Writer writes VERSIONS[0..n), then Reader reopens the same file.
  async function writeThenRead(Writer, Reader, filename) {
    let log = await open(Writer, filename, 3, true);
    for (let i = 0; i < 6; i++) await log.addVersion(VERSIONS[i]);
    await log.close();

    log = await open(Reader, filename, 3, false);
    expect(log.getCurrentVersion()).toBe(6);
    expect(log.diffsPerSnapshot).toBe(3);
    for (let i = 0; i < 6; i++) {
      expect(await log.getVersion(i + 1)).toBe(VERSIONS[i]);
    }
    // Reader can append; Writer then reads those back.
    await log.addVersion(VERSIONS[6]);
    await log.addVersion(VERSIONS[7]);
    await log.close();

    log = await open(Writer, filename, 3, false);
    expect(log.getCurrentVersion()).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(await log.getVersion(i + 1)).toBe(VERSIONS[i]);
    }
    await log.close();
    await deleteFile(root, filename);
  }

  it('JS writes, WASM reads (and appends, JS reads back)', async () => {
    await writeThenRead(TextLogJS, TextLogWasm, name());
  });

  it('WASM writes, JS reads (and appends, WASM reads back)', async () => {
    await writeThenRead(TextLogWasm, TextLogJS, name());
  });

  it('getDiff matches across implementations', async () => {
    const fnJs = name();
    const fnWasm = name();
    let a = await open(TextLogJS, fnJs, 3, true);
    let b = await open(TextLogWasm, fnWasm, 3, true);
    for (let i = 0; i < VERSIONS.length; i++) {
      await a.addVersion(VERSIONS[i]);
      await b.addVersion(VERSIONS[i]);
    }
    const diffJs = await a.getDiff(1, VERSIONS.length);
    const diffWasm = await b.getDiff(1, VERSIONS.length);
    expect(diffWasm).toBe(diffJs);
    await a.close();
    await b.close();
    await deleteFile(root, fnJs);
    await deleteFile(root, fnWasm);
  });

  it('stores byte-identical entry payloads (snapshots + patches)', async () => {
    const fnJs = name();
    const fnWasm = name();
    let a = await open(TextLogJS, fnJs, 3, true);
    let b = await open(TextLogWasm, fnWasm, 3, true);
    for (let i = 0; i < VERSIONS.length; i++) {
      await a.addVersion(VERSIONS[i]);
      await b.addVersion(VERSIONS[i]);
    }
    await a.close();
    await b.close();

    const entriesJs = await scanEntries(fnJs);
    const entriesWasm = await scanEntries(fnWasm);
    expect(entriesWasm.length).toBe(entriesJs.length);
    expect(entriesJs.length).toBe(VERSIONS.length);
    for (let i = 0; i < entriesJs.length; i++) {
      // type, version, hash and the stored data (full text or unified-diff
      // patch string) must be byte-identical; only the timestamp may differ.
      expect(entriesWasm[i].type).toBe(entriesJs[i].type);
      expect(entriesWasm[i].version).toBe(entriesJs[i].version);
      expect(entriesWasm[i].hash).toBe(entriesJs[i].hash);
      expect(entriesWasm[i].data).toBe(entriesJs[i].data);
    }
    // Sanity: at least one snapshot and one DIFF entry were exercised.
    expect(entriesJs.some(e => e.type === 0x01)).toBe(true);
    expect(entriesJs.some(e => e.type === 0x02)).toBe(true);

    await deleteFile(root, fnJs);
    await deleteFile(root, fnWasm);
  });
});
