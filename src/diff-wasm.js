/**
 * WASM-backed diff engine — a thin JS wrapper over the byte-for-byte C port of
 * the `diff` package (jsdiff 8.0.3) in c/diff.c.
 *
 * Exposes the three functions src/textlog.js relies on:
 *   - createPatch(fileName, a, b)  -> unified diff string (INCLUDE_HEADERS)
 *   - unifiedDiff(a, b, fromLabel, toLabel) -> the getDiff-style unified diff
 *     textlog.js renders (no Index/underline header lines)
 *   - applyPatch(source, patch)    -> patched string, or null if it doesn't fit
 *
 * Output matches jsdiff exactly; see test/textlog-interop.test.js. The module
 * loads asynchronously — await ready() before calling.
 */
import createDiffModule from '../lib/diff-core.mjs';

let Module = null;
let readyPromise = null;

/** Instantiate the WASM module (idempotent). */
export function ready() {
  if (!readyPromise) {
    readyPromise = createDiffModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
export function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) throw new Error('diff-wasm not initialized: await ready() before use');
  return Module;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Little-endian u32 read from the heap (HEAPU32 isn't exported). */
function readU32(M, addr) {
  const b = M.HEAPU8;
  return (b[addr] | (b[addr + 1] << 8) | (b[addr + 2] << 16) | (b[addr + 3] * 0x1000000)) >>> 0;
}

/** Copy a JS string into the heap as UTF-8; returns { ptr, len }. */
function writeBytes(M, str) {
  const bytes = encoder.encode(str);
  const ptr = M._malloc(bytes.length || 1);
  if (bytes.length) M.HEAPU8.set(bytes, ptr);
  return { ptr, len: bytes.length };
}

/** Copy a JS string into the heap as a NUL-terminated C string; returns ptr. */
function writeCString(M, str) {
  const bytes = encoder.encode(str);
  const ptr = M._malloc(bytes.length + 1);
  if (bytes.length) M.HEAPU8.set(bytes, ptr);
  M.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

/**
 * Read a (uint8_t** out, size_t* outlen) result the C side malloc'd, decode it
 * as UTF-8, and free the C buffer. `outPP`/`outLP` are heap slots holding the
 * pointer and length.
 */
function takeOut(M, outPP, outLP) {
  const outPtr = readU32(M, outPP);
  const outLen = readU32(M, outLP);
  const bytes = M.HEAPU8.slice(outPtr, outPtr + outLen);
  if (outPtr) M._free(outPtr);
  return decoder.decode(bytes);
}

/** createPatch(fileName, a, b) — full unified diff with INCLUDE_HEADERS. */
export function createPatch(fileName, a, b) {
  const M = requireModule();
  const namePtr = writeCString(M, fileName);
  const A = writeBytes(M, a), B = writeBytes(M, b);
  const outPP = M._malloc(4), outLP = M._malloc(4);
  try {
    const rc = M._diff_create_patch(namePtr, A.ptr, A.len, B.ptr, B.len, outPP, outLP);
    if (rc !== 0) throw new Error(`createPatch failed (${rc})`);
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(namePtr); M._free(A.ptr); M._free(B.ptr); M._free(outPP); M._free(outLP);
  }
}

/**
 * The unified diff textlog.js's getDiff renders: `--- <fromLabel>` / `+++
 * <toLabel>` headers followed by `@@`/context/`+`/`-` lines. Labels default to
 * matching textlog's `version 1` / `version 2`.
 */
export function unifiedDiff(a, b, fromLabel = 1, toLabel = 2) {
  const M = requireModule();
  const A = writeBytes(M, a), B = writeBytes(M, b);
  const outPP = M._malloc(4), outLP = M._malloc(4);
  try {
    const rc = M._diff_get_diff(fromLabel | 0, toLabel | 0, A.ptr, A.len, B.ptr, B.len, outPP, outLP);
    if (rc !== 0) throw new Error(`unifiedDiff failed (${rc})`);
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(A.ptr); M._free(B.ptr); M._free(outPP); M._free(outLP);
  }
}

/** applyPatch(source, patch) — returns the patched string, or null if it doesn't fit. */
export function applyPatch(source, patch) {
  const M = requireModule();
  const S = writeBytes(M, source), P = writeBytes(M, patch);
  const outPP = M._malloc(4), outLP = M._malloc(4), appliedP = M._malloc(4);
  try {
    const rc = M._diff_apply_patch(S.ptr, S.len, P.ptr, P.len, outPP, outLP, appliedP);
    if (rc !== 0) throw new Error(`applyPatch failed (${rc})`);
    if (readU32(M, appliedP) === 0) return null;
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(S.ptr); M._free(P.ptr); M._free(outPP); M._free(outLP); M._free(appliedP);
  }
}
