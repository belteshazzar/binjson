/**
 * WASM-backed persistent on-disk R-tree.
 *
 * Drop-in replacement for src/rtree.js: the tree algorithm and node
 * serialization run in C compiled to WebAssembly (see c/rtree.c), while the OPFS
 * file I/O — a browser API with no WASM equivalent — stays in JS. The on-disk
 * format is identical to the reference, so files interoperate and
 * bin/rtree-decode.js can read trees produced here.
 *
 * The C side owns an in-memory image of the append-only file: open() hands it
 * the existing bytes, mutations append to it, and close()/flush() write the
 * image back to the sync handle. Points are marshalled as (lat, lng) doubles
 * plus a 12-byte ObjectId; search/compact results come back as binjson bytes
 * decoded with src/binjson.js.
 *
 * Haversine / radius math stays here (identical to the reference) so results
 * match: C returns the entries inside a query bounding box and JS applies the
 * distance filter.
 *
 * The WASM module loads asynchronously; open() awaits it, so — as with the
 * reference — call and await open() before any other method.
 */
import createRtreeModule from '../lib/rtree-core.mjs';
import { decode, ObjectId } from './binjson.js';

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

let Module = null;
let readyPromise = null;

/** Instantiate the WASM module (idempotent). Awaited by open(). */
function ready() {
  if (!readyPromise) {
    readyPromise = createRtreeModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) {
    throw new Error('rtree-wasm not initialized: await open() before use');
  }
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `rtree error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

/** Haversine distance in kilometers (matches the reference). */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Convert a radius query into a bounding box (matches the reference). */
function radiusToBoundingBox(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}

/**
 * Persistent on-disk R-tree with append-only WASM-backed storage.
 * Mirrors the API of src/rtree.js.
 */
export class RTree {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} maxEntries - node capacity (default 9, minimum 2)
   *
   * The tree is durable: every mutation writes its appended bytes straight
   * through to the file handle (matching the write-through model of
   * src/rtree.js), so data survives a crash before close().
   */
  constructor(syncHandle, maxEntries = 9) {
    this.syncAccessHandle = syncHandle;
    this.maxEntries = maxEntries;
    this.isOpen = false;
    this.ctx = 0;
    this._size = 0;
    this._flushedLen = 0; // image bytes already written to the handle

    // Shim exposing file size, used by some tests (tree.file.getFileSize()).
    this.file = {
      getFileSize: () => (this.ctx ? Module._rtw_image_len(this.ctx)
                                   : this.syncAccessHandle.getSize())
    };
  }

  /** Open the tree: load an existing file image or initialize a new one. */
  async open() {
    if (this.isOpen) {
      throw new Error('R-tree is already open');
    }
    const M = await ready();

    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      const buf = new Uint8Array(fileSize);
      this.syncAccessHandle.read(buf, { at: 0 });
      const ptr = M._malloc(fileSize);
      M.HEAPU8.set(buf, ptr);
      this.ctx = M._rtw_load(ptr, fileSize);
      M._free(ptr);
      if (!this.ctx) throw new Error('Invalid R-tree file');
      this.maxEntries = M._rtw_max_entries(this.ctx);
      this._flushedLen = fileSize; // existing bytes are already on disk
    } else {
      this.ctx = M._rtw_create(this.maxEntries);
      if (!this.ctx) throw new Error('Failed to create R-tree');
      this._flushedLen = 0;
    }
    this._size = M._rtw_size(this.ctx);
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
    const len = M._rtw_image_len(this.ctx);
    if (len > this._flushedLen) {
      const ptr = M._rtw_image_ptr(this.ctx);
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
      Module._rtw_free(this.ctx);
      this.ctx = 0;
    }
    this.isOpen = false;
  }

  /** Insert a point (lat, lng) associated with an ObjectId. */
  insert(lat, lng, objectId) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to insert into rtree');
    }
    const M = requireModule();
    const bytes = objectId.toBytes();
    const ptr = M._malloc(12);
    M.HEAPU8.set(bytes, ptr);
    try {
      const rc = M._rtw_insert(this.ctx, lat, lng, ptr);
      if (rc !== 0) throw codeError(rc, 'insert');
      this._size = M._rtw_size(this.ctx);
      this._writeThrough();
    } finally {
      M._free(ptr);
    }
  }

  /** Remove the entry for an ObjectId. Returns true if one was removed. */
  remove(objectId) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to remove from rtree');
    }
    const M = requireModule();
    const bytes = objectId.toBytes();
    const ptr = M._malloc(12);
    M.HEAPU8.set(bytes, ptr);
    try {
      const rc = M._rtw_remove(this.ctx, ptr);
      if (rc < 0) throw codeError(rc, 'remove');
      this._size = M._rtw_size(this.ctx);
      this._writeThrough();
      return rc === 1;
    } finally {
      M._free(ptr);
    }
  }

  /** Candidate entries whose point falls inside a bounding box. */
  _searchBBoxRaw(bbox) {
    const M = requireModule();
    const rc = M._rtw_search(this.ctx, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    if (rc !== 0) throw codeError(rc, 'searchBBox');
    const ptr = M._rtw_out_ptr(this.ctx);
    const len = M._rtw_out_len(this.ctx);
    if (len === 0) return [];
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /** Search for points within a bounding box; returns { objectId, lat, lng }. */
  searchBBox(bbox) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    return this._searchBBoxRaw(bbox);
  }

  /**
   * Search for points within a radius (km) of a location; returns
   * { objectId, lat, lng, distance }.
   */
  searchRadius(lat, lng, radiusKm) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    const bbox = radiusToBoundingBox(lat, lng, radiusKm);
    const candidates = this._searchBBoxRaw(bbox);
    const results = [];
    for (const entry of candidates) {
      const dist = haversineDistance(lat, lng, entry.lat, entry.lng);
      if (dist <= radiusKm) {
        results.push({ objectId: entry.objectId, lat: entry.lat, lng: entry.lng, distance: dist });
      }
    }
    return results;
  }

  /** Drop all entries by appending a fresh empty root. */
  async clear() {
    const M = requireModule();
    const rc = M._rtw_clear(this.ctx);
    if (rc !== 0) throw codeError(rc, 'clear');
    this._size = 0;
    this._writeThrough();
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
      throw new Error('R-tree file must be opened before use');
    }
    if (!destSyncHandle) {
      throw new Error('Destination sync handle is required for compaction');
    }
    const M = requireModule();
    const oldSize = M._rtw_image_len(this.ctx);

    const rc = M._rtw_compact(this.ctx);
    if (rc !== 0) throw codeError(rc, 'compact');
    const ptr = M._rtw_out_ptr(this.ctx);
    const newSize = M._rtw_out_len(this.ctx);
    const bytes = M.HEAPU8.slice(ptr, ptr + newSize);

    destSyncHandle.truncate(0);
    destSyncHandle.write(bytes, { at: 0 });
    destSyncHandle.flush();
    await destSyncHandle.close();

    return {
      oldSize,
      newSize,
      bytesSaved: Math.max(0, oldSize - newSize)
    };
  }
}

export { ready, isReady };
export default RTree;
