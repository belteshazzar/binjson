/**
 * WASM-backed full-text index.
 *
 * Drop-in replacement for src/textindex.js: tokenization, stop-word filtering,
 * Porter stemming and TF-IDF relevance scoring all run in C compiled to
 * WebAssembly (see c/textindex.c, c/stemmer.c), operating on three C B+ trees
 * (c/bplustree.c). The OPFS file I/O for the three tree files stays in JS.
 *
 * This module exports its own WASM `BPlusTree` (backed by the textindex-core
 * module) plus `TextIndex`; construct the three trees and hand them to
 * TextIndex exactly as with the reference. The WASM module loads asynchronously
 * — await the trees' open() (which awaits it) before use.
 */
import createTextindexModule from '../lib/textindex-core.mjs';
import { encode, decode } from './binjson.js';

// Error codes — must match the BJ_ERR_* constants in c/binjson.h.
const ERR = {
  [-1]: 'out of memory',
  [-2]: 'builder state error',
  [-3]: 'Unexpected end of data',
  [-4]: 'Unknown type byte',
  [-5]: 'Decoded integer exceeds safe range',
  [-6]: 'Pointer offset out of valid range',
  [-7]: 'Maximum nesting depth exceeded'
};

const textEncoder = new TextEncoder();

let Module = null;
let readyPromise = null;

/** Instantiate the WASM module (idempotent). Awaited by open(). */
function ready() {
  if (!readyPromise) {
    readyPromise = createTextindexModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) throw new Error('textindex-wasm not initialized: await open() before use');
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `textindex error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

/** Copy a JS string into the heap as UTF-8; returns { ptr, len, free }. */
function allocStr(M, str) {
  const bytes = textEncoder.encode(str);
  const len = bytes.length;
  const ptr = M._malloc(len || 1);
  if (len) M.HEAPU8.set(bytes, ptr);
  return { ptr, len, free() { M._free(ptr); } };
}

/**
 * WASM B+ tree used to back a TextIndex. A trimmed sibling of
 * src/bplustree-wasm.js (same textindex-core module) exposing the tree handle
 * (`ctx`) so the C index code can mutate it directly, plus `syncAfter()` to
 * flush the appended bytes back to OPFS after those mutations.
 */
class BPlusTree {
  constructor(syncHandle, order = 3) {
    if (order < 3) {
      throw new Error('B+ tree order must be at least 3');
    }
    this.syncAccessHandle = syncHandle;
    this.order = order;
    this.isOpen = false;
    this.ctx = 0;
    this._flushedLen = 0;
  }

  async open() {
    if (this.isOpen) throw new Error('Tree is already open');
    const M = await ready();
    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      const buf = new Uint8Array(fileSize);
      this.syncAccessHandle.read(buf, { at: 0 });
      const ptr = M._malloc(fileSize);
      M.HEAPU8.set(buf, ptr);
      this.ctx = M._bptw_load(ptr, fileSize);
      M._free(ptr);
      if (!this.ctx) throw new Error('Invalid tree file');
      this.order = M._bptw_order(this.ctx);
      this._flushedLen = fileSize;
    } else {
      this.ctx = M._bptw_create(this.order);
      if (!this.ctx) throw new Error('Failed to create B+ tree');
      this._flushedLen = 0;
    }
    this.isOpen = true;
    this._writeThrough();
  }

  _writeThrough() {
    const M = requireModule();
    const len = M._bptw_image_len(this.ctx);
    if (len > this._flushedLen) {
      const ptr = M._bptw_image_ptr(this.ctx);
      const chunk = M.HEAPU8.slice(ptr + this._flushedLen, ptr + len);
      this.syncAccessHandle.write(chunk, { at: this._flushedLen });
      this._flushedLen = len;
    }
  }

  /** Flush appended bytes after C-side mutations (via the tix* functions). */
  syncAfter() { this._writeThrough(); }

  flush() {
    this._writeThrough();
    this.syncAccessHandle.flush();
  }

  async close() {
    if (!this.isOpen) return;
    if (this.syncAccessHandle) {
      this.flush();
      await this.syncAccessHandle.close();
    }
    if (this.ctx) {
      Module._bptw_free(this.ctx);
      this.ctx = 0;
    }
    this.isOpen = false;
  }

  #allocKey(key) {
    const M = Module;
    if (typeof key === 'number') return { type: 0, num: key, ptr: 0, len: 0, free() {} };
    if (typeof key === 'string') {
      const s = allocStr(M, key);
      return { type: 1, num: 0, ptr: s.ptr, len: s.len, free: s.free };
    }
    throw new Error(`Unsupported key type: ${typeof key}`);
  }

  /** All entries as an array of { key, value } in sorted order. */
  toArray() {
    const M = requireModule();
    const rc = M._bptw_entries(this.ctx);
    if (rc !== 0) throw codeError(rc, 'toArray');
    const ptr = M._bptw_out_ptr();
    const len = M._bptw_out_len();
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /** Insert or update a key-value pair (used by compaction). */
  add(key, value) {
    const M = requireModule();
    const k = this.#allocKey(key);
    const vbytes = encode(value);
    const vlen = vbytes.length;
    const vptr = vlen ? M._malloc(vlen) : 0;
    if (vlen) M.HEAPU8.set(vbytes, vptr);
    try {
      const rc = M._bptw_add(this.ctx, k.type, k.num, k.ptr, k.len, vptr, vlen);
      if (rc !== 0) throw codeError(rc, 'add');
      this._writeThrough();
    } finally {
      k.free();
      if (vlen) M._free(vptr);
    }
  }

  size() { return requireModule()._bptw_size(this.ctx); }

  /** Compact into a fresh file, dropping stale append-only history. */
  async compact(destSyncHandle) {
    if (!this.isOpen) throw new Error('Tree file is not open');
    if (!destSyncHandle) throw new Error('Destination sync handle is required for compaction');
    const M = requireModule();
    const oldSize = M._bptw_image_len(this.ctx);
    const entries = this.toArray();
    const newTree = new BPlusTree(destSyncHandle, this.order);
    await newTree.open();
    for (const entry of entries) newTree.add(entry.key, entry.value);
    const newSize = M._bptw_image_len(newTree.ctx);
    await newTree.close();
    return { oldSize, newSize, bytesSaved: Math.max(0, oldSize - newSize) };
  }
}

/**
 * WASM full-text index. Mirrors the API of src/textindex.js.
 */
class TextIndex {
  constructor(options = {}) {
    const { order = 16, trees } = options;
    this.order = order;
    this.index = trees?.index || null;
    this.documentTerms = trees?.documentTerms || null;
    this.documentLengths = trees?.documentLengths || null;
    this.isOpen = false;
  }

  async open() {
    if (this.isOpen) throw new Error('TextIndex is already open');
    if (!this.index || !this.documentTerms || !this.documentLengths) {
      throw new Error('Trees must be initialized before opening');
    }
    await Promise.all([this.index.open(), this.documentTerms.open(), this.documentLengths.open()]);
    this.isOpen = true;
  }

  async close() {
    if (!this.isOpen) return;
    await Promise.all([this.index.close(), this.documentTerms.close(), this.documentLengths.close()]);
    this.isOpen = false;
  }

  _ensureOpen() {
    if (!this.isOpen) throw new Error('TextIndex is not open');
  }

  _ctxs() {
    return [this.index.ctx, this.documentTerms.ctx, this.documentLengths.ctx];
  }

  _syncAll() {
    this.index.syncAfter();
    this.documentTerms.syncAfter();
    this.documentLengths.syncAfter();
  }

  async add(docId, text) {
    this._ensureOpen();
    if (!docId) throw new Error('Document ID is required');
    const M = requireModule();
    const t = typeof text === 'string' ? text : '';
    const d = allocStr(M, docId);
    const x = allocStr(M, t);
    try {
      const [ix, dt, dl] = this._ctxs();
      const rc = M._tixw_add(ix, dt, dl, d.ptr, d.len, x.ptr, x.len);
      if (rc !== 0) throw codeError(rc, 'add');
      this._syncAll();
    } finally {
      d.free(); x.free();
    }
  }

  async remove(docId) {
    this._ensureOpen();
    const M = requireModule();
    const d = allocStr(M, String(docId));
    try {
      const [ix, dt, dl] = this._ctxs();
      const rc = M._tixw_remove(ix, dt, dl, d.ptr, d.len);
      if (rc < 0) throw codeError(rc, 'remove');
      this._syncAll();
      return rc === 1;
    } finally {
      d.free();
    }
  }

  _readOut(M) {
    const ptr = M._tixw_out_ptr();
    const len = M._tixw_out_len();
    if (len === 0) return [];
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  async query(queryText, options = { scored: true, requireAll: false }) {
    this._ensureOpen();
    const M = requireModule();
    const q = allocStr(M, typeof queryText === 'string' ? queryText : '');
    try {
      const [ix, dt, dl] = this._ctxs();
      if (options.requireAll) {
        const rc = M._tixw_query_all(ix, dt, dl, q.ptr, q.len);
        if (rc !== 0) throw codeError(rc, 'query');
        return this._readOut(M); // array of id strings
      }
      const rc = M._tixw_query(ix, dt, dl, q.ptr, q.len);
      if (rc !== 0) throw codeError(rc, 'query');
      const results = this._readOut(M); // array of { id, score }
      if (options.scored === false) return results.map(r => r.id);
      return results;
    } finally {
      q.free();
    }
  }

  async getTermCount() {
    this._ensureOpen();
    return this.index.size();
  }

  async getDocumentCount() {
    this._ensureOpen();
    return this.documentTerms.size();
  }

  async clear() {
    this._ensureOpen();
    const M = requireModule();
    const [ix, dt, dl] = this._ctxs();
    const rc = M._tixw_clear(ix, dt, dl);
    if (rc !== 0) throw codeError(rc, 'clear');
    this._syncAll();
  }

  async compact({ index: destIndex, documentTerms: destDocTerms, documentLengths: destDocLengths }) {
    this._ensureOpen();
    if (!destIndex || !destDocTerms || !destDocLengths) {
      throw new Error('Destination trees must be provided for compaction');
    }
    const terms = await this.index.compact(destIndex.syncAccessHandle);
    const documents = await this.documentTerms.compact(destDocTerms.syncAccessHandle);
    const lengths = await this.documentLengths.compact(destDocLengths.syncAccessHandle);
    await this.close();
    this.isOpen = false;
    return { terms, documents, lengths };
  }
}

export { ready, isReady, BPlusTree, TextIndex };
