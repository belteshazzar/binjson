/**
 * WASM-backed persistent B+ tree.
 *
 * Drop-in replacement for src/bplustree.js: the tree algorithm and node
 * serialization run in C compiled to WebAssembly (see c/bplustree.c), while the
 * OPFS file I/O — which is a browser API with no WASM equivalent — stays in JS.
 * The on-disk format is identical to the reference, so files interoperate and
 * bin/bplustree-decode.js can read trees produced here.
 *
 * The C side owns an in-memory image of the append-only file: open() hands it the
 * existing bytes, mutations append to it, and close()/flush() write the image
 * back to the sync handle. Keys are marshalled as number|string; values are
 * encoded to binjson bytes (via src/binjson.js) and carried opaquely by C.
 *
 * The WASM module loads asynchronously; open() awaits it, so — as with the
 * reference — call and await open() before any other method.
 */
import createBplustreeModule from '../lib/bplustree.wasm.mjs';
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
    readyPromise = createBplustreeModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) {
    throw new Error('bplustree-wasm not initialized: await open() before use');
  }
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `bplustree error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

/**
 * Persistent immutable B+ tree with append-only WASM-backed storage.
 * Mirrors the API of src/bplustree.js.
 */
class BPlusTree {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} order - tree order (default 3, minimum 3)
   *
   * The tree is durable: every add/delete writes its appended bytes straight
   * through to the file handle (matching the write-through model of
   * src/bplustree.js), so data survives a crash before close().
   */
  constructor(syncHandle, order = 3) {
    if (order < 3) {
      throw new Error('B+ tree order must be at least 3');
    }
    this.syncAccessHandle = syncHandle;
    this.order = order;
    this.isOpen = false;
    this.ctx = 0;
    this._size = 0;
    this._flushedLen = 0; // image bytes already written to the handle
  }

  /** Open the tree: load an existing file image or initialize a new one. */
  async open() {
    if (this.isOpen) {
      throw new Error('Tree is already open');
    }
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
      this._flushedLen = fileSize; // existing bytes are already on disk
    } else {
      this.ctx = M._bptw_create(this.order);
      if (!this.ctx) throw new Error('Failed to create B+ tree');
      this._flushedLen = 0;
    }
    this._size = M._bptw_size(this.ctx);
    this.isOpen = true;
    // Persist the freshly-created root + metadata immediately, as the reference
    // does in _initializeNewTree.
    this._writeThrough();
  }

  /**
   * Append the image bytes not yet on disk to the file handle (no fsync). The
   * image is append-only, so only the tail past _flushedLen is ever new.
   */
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

  /** Persist any pending image bytes to the sync handle and fsync. */
  flush() {
    this._writeThrough();
    this.syncAccessHandle.flush();
  }

  /** Persist, close the sync handle, and release the WASM context. */
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

  /** Allocate a marshalled key; caller must call .free(). */
  #allocKey(key) {
    const M = Module;
    if (typeof key === 'number') {
      return { type: 0, num: key, ptr: 0, len: 0, free() {} };
    }
    if (typeof key === 'string') {
      const bytes = textEncoder.encode(key);
      const len = bytes.length;
      const ptr = len ? M._malloc(len) : 0;
      if (len) M.HEAPU8.set(bytes, ptr);
      return { type: 1, num: 0, ptr, len, free() { if (len) M._free(ptr); } };
    }
    throw new Error(`Unsupported key type: ${typeof key}`);
  }

  /** Insert or update a key-value pair. */
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
      this._size = M._bptw_size(this.ctx);
      this._writeThrough();
    } finally {
      k.free();
      if (vlen) M._free(vptr);
    }
  }

  /** Search for a key; returns the value or undefined. */
  search(key) {
    const M = requireModule();
    const k = this.#allocKey(key);
    try {
      const rc = M._bptw_search(this.ctx, k.type, k.num, k.ptr, k.len);
      if (rc < 0) throw codeError(rc, 'search');
      if (rc === 0) return undefined;
      const ptr = M._bptw_out_ptr();
      const len = M._bptw_out_len();
      return decode(M.HEAPU8.slice(ptr, ptr + len));
    } finally {
      k.free();
    }
  }

  /** Delete a key (no-op if absent). */
  delete(key) {
    const M = requireModule();
    const k = this.#allocKey(key);
    try {
      const rc = M._bptw_delete(this.ctx, k.type, k.num, k.ptr, k.len);
      if (rc !== 0) throw codeError(rc, 'delete');
      this._size = M._bptw_size(this.ctx);
      this._writeThrough();
    } finally {
      k.free();
    }
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

  /** Entries with min <= key <= max, in sorted order. */
  rangeSearch(minKey, maxKey) {
    const M = requireModule();
    const kmin = this.#allocKey(minKey);
    const kmax = this.#allocKey(maxKey);
    try {
      const rc = M._bptw_range(
        this.ctx,
        kmin.type, kmin.num, kmin.ptr, kmin.len,
        kmax.type, kmax.num, kmax.ptr, kmax.len
      );
      if (rc !== 0) throw codeError(rc, 'rangeSearch');
      const ptr = M._bptw_out_ptr();
      const len = M._bptw_out_len();
      return decode(M.HEAPU8.slice(ptr, ptr + len));
    } finally {
      kmin.free();
      kmax.free();
    }
  }

  /** Async iterator over { key, value } entries in sorted order. */
  async *[Symbol.asyncIterator]() {
    if (!this.isOpen) {
      throw new Error('Tree must be open before iteration');
    }
    if (this._size === 0) return;
    for (const entry of this.toArray()) {
      yield entry;
    }
  }

  /** Tree height (0 for a single leaf). */
  getHeight() {
    const M = requireModule();
    const h = M._bptw_height(this.ctx);
    if (h < 0) throw codeError(h, 'getHeight');
    return h;
  }

  size() {
    return this._size;
  }

  isEmpty() {
    return this._size === 0;
  }

  /**
   * Compact into a fresh file, dropping stale append-only history.
   * @param {FileSystemSyncAccessHandle} destSyncHandle
   * @returns {Promise<{oldSize:number,newSize:number,bytesSaved:number}>}
   */
  async compact(destSyncHandle) {
    if (!this.isOpen) {
      throw new Error('Tree file is not open');
    }
    if (!destSyncHandle) {
      throw new Error('Destination sync handle is required for compaction');
    }
    const M = requireModule();
    const oldSize = M._bptw_image_len(this.ctx);

    const entries = this.toArray();
    const newTree = new BPlusTree(destSyncHandle, this.order);
    await newTree.open();
    for (const entry of entries) {
      newTree.add(entry.key, entry.value);
    }
    const newSize = M._bptw_image_len(newTree.ctx);
    await newTree.close();

    return {
      oldSize,
      newSize,
      bytesSaved: Math.max(0, oldSize - newSize)
    };
  }
}

export { ready, isReady, BPlusTree };
