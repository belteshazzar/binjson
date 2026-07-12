/**
 * Loader for the frozen legacy-format fixtures in test/fixtures/legacy/.
 *
 * These are binary files written by the (removed) pure-JS data-structure
 * implementations; the WASM engine must keep reading and upgrading them.
 * See test/fixtures/generate-legacy-fixtures.mjs for exact provenance.
 */
import { readFileSync } from 'fs';

/**
 * Write a fixture's bytes into an open FileSystemSyncAccessHandle, flush and
 * close it. The handle should have been opened with { create: true } on a
 * fresh file; afterwards reopen the file to use it.
 */
export function writeFixture(syncHandle, fixtureName) {
  const bytes = readFileSync(new URL(`./fixtures/legacy/${fixtureName}`, import.meta.url));
  syncHandle.truncate(0);
  syncHandle.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { at: 0 });
  syncHandle.flush();
  syncHandle.close();
}
