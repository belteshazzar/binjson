/**
 * WASM-backed persistent text versioning log.
 *
 * Drop-in replacement for src/textlog.js: the append-only storage, snapshot/diff
 * strategy, SHA-256 hashing and diff/patch logic all run in C compiled to
 * WebAssembly (see c/textlog.c and c/diff.c), while the OPFS file I/O — a
 * browser API with no WASM equivalent — stays in JS.
 *
 * The diff engine (c/diff.c) is a byte-for-byte port of the `diff` package's
 * createPatch / applyPatch / structuredPatch, and entry/metadata records use the
 * same binjson shapes as the reference, so the on-disk format is identical: a
 * file written by this log is fully readable by src/textlog.js and vice versa
 * (see test/textlog-interop.test.js). Only the per-entry timestamp differs
 * between two independent writes, since it is wall-clock at write time.
 *
 * The C side owns an in-memory image of the append-only file: open() hands it
 * the existing bytes, mutations append to it, and close()/flush() write the
 * image back to the sync handle.
 *
 * The WASM module loads asynchronously; open() awaits it, so — as with the
 * reference — call and await open() before any other method.
 */
import createTextlogModule from '../lib/textlog-core.mjs';

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
    readyPromise = createTextlogModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) {
    throw new Error('textlog-wasm not initialized: await open() before use');
  }
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `textlog error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Persistent versioned text log with append-only WASM-backed storage.
 * Mirrors the API of src/textlog.js.
 */
export class TextLog {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} diffsPerSnapshot - diffs between full snapshots (default 10)
   */
  constructor(syncHandle, diffsPerSnapshot = 10) {
    if (diffsPerSnapshot < 1) {
      throw new Error('diffsPerSnapshot must be at least 1');
    }
    this.syncAccessHandle = syncHandle;
    this.diffsPerSnapshot = diffsPerSnapshot;
    this.isOpen = false;
    this.ctx = 0;
    this.version = 0;
    this._flushedLen = 0; // image bytes already written to the handle

    // Shim mirroring the reference's `file` member (used by some tests).
    this.file = {
      syncAccessHandle: syncHandle,
      getFileSize: () => (this.ctx ? Module._tlw_image_len(this.ctx)
                                   : this.syncAccessHandle.getSize())
    };
  }

  /** Open the log: load an existing file image or initialize a new one. */
  async open() {
    if (this.isOpen) {
      throw new Error('TextLog is already open');
    }
    const M = await ready();

    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      const buf = new Uint8Array(fileSize);
      this.syncAccessHandle.read(buf, { at: 0 });
      const ptr = M._malloc(fileSize);
      M.HEAPU8.set(buf, ptr);
      this.ctx = M._tlw_load(ptr, fileSize);
      M._free(ptr);
      if (!this.ctx) {
        throw new Error('Failed to read metadata: no valid metadata found');
      }
      this.diffsPerSnapshot = M._tlw_diffs_per_snapshot(this.ctx);
      this._flushedLen = fileSize; // existing bytes are already on disk
    } else {
      this.ctx = M._tlw_create(this.diffsPerSnapshot);
      if (!this.ctx) throw new Error('Failed to create TextLog');
      this._flushedLen = 0;
    }
    this.version = M._tlw_version(this.ctx);
    this.isOpen = true;
    // Persist the freshly-created metadata immediately, as the reference does
    // in _initializeNewLog.
    this._writeThrough();
  }

  /**
   * Append the image bytes not yet on disk to the file handle (no fsync). The
   * image is append-only, so only the tail past _flushedLen is ever new.
   */
  _writeThrough() {
    const M = requireModule();
    const len = M._tlw_image_len(this.ctx);
    if (len > this._flushedLen) {
      const ptr = M._tlw_image_ptr(this.ctx);
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
      Module._tlw_free(this.ctx);
      this.ctx = 0;
    }
    this.isOpen = false;
  }

  /** Read the current output buffer as a UTF-8 string. */
  _readOut(M) {
    const ptr = M._tlw_out_ptr(this.ctx);
    const len = M._tlw_out_len(this.ctx);
    if (len === 0) return '';
    return decoder.decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /**
   * Add a new version of the text.
   * @param {string} text - full text content for this version
   * @returns {number} the new version number
   */
  async addVersion(text) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }
    const M = requireModule();
    const bytes = encoder.encode(text);
    const ptr = M._malloc(bytes.length || 1);
    if (bytes.length) M.HEAPU8.set(bytes, ptr);
    try {
      const v = M._tlw_add_version(this.ctx, ptr, bytes.length, Date.now());
      if (v < 0) throw codeError(v, 'addVersion');
      this.version = v;
      this._writeThrough();
      return v;
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Get the full text at a specific version.
   * @param {number} version - version number to retrieve
   * @returns {string} the text at that version
   */
  async getVersion(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (version < 1 || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: 1-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_version(this.ctx, version);
    if (rc !== 0) throw codeError(rc, 'getVersion');
    return this._readOut(M);
  }

  /**
   * Get a human-readable diff between two versions.
   * @param {number} fromVersion - starting version
   * @param {number} toVersion - ending version
   * @returns {string} human-readable unified diff
   */
  async getDiff(fromVersion, toVersion) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (fromVersion < 1 || fromVersion > this.version) {
      throw new Error(`Invalid fromVersion: ${fromVersion}. Valid range: 1-${this.version}`);
    }
    if (toVersion < 1 || toVersion > this.version) {
      throw new Error(`Invalid toVersion: ${toVersion}. Valid range: 1-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_diff(this.ctx, fromVersion, toVersion);
    if (rc !== 0) throw codeError(rc, 'getDiff');
    return this._readOut(M);
  }

  /** Get current version number. */
  getCurrentVersion() {
    return this.version;
  }

  /**
   * Get the SHA-256 hash of a specific version.
   * @param {number} version - version number
   * @returns {string} hex string hash
   */
  async getVersionHash(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (version < 1 || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: 1-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_version_hash(this.ctx, version);
    if (rc !== 0) throw codeError(rc, 'getVersionHash');
    return this._readOut(M);
  }
}

// Entry type constants (mirror src/textlog.js).
const ENTRY_TYPE = {
  FULL_SNAPSHOT: 0x01,
  DIFF: 0x02
};

export { ready, isReady, ENTRY_TYPE };
export default TextLog;
