/**
 * db.js — public entry point for the document database.
 *
 * The implementation lives in binjson-wasm.js alongside BPlusTree/RTree/
 * TextIndex, since it needs the same direct access to the WASM Module those
 * classes share; this file just gives it a stable, dedicated import path
 * (see the "./db" entry in package.json). The actual database logic —
 * catalog bookkeeping, document CRUD, filter matching — is implemented in
 * C (c/db.c, c/db_wasm.c); Collection/Db here only marshal bytes across the
 * WASM bridge.
 */
export {
  Db,
  Collection,
  ChangeStream,
  MemoryStorageProvider,
  OPFSStorageProvider,
  connect
} from './binjson-wasm.js';
