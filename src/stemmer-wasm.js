/**
 * WASM-backed Porter stemmer — a thin JS wrapper over the byte-for-byte C port
 * of the `stemmer` package (v2.0.1) in c/stemmer.c.
 *
 * `stemmer(word)` returns the same stem as the npm package for ASCII word input
 * (verified against the full system dictionary; see the conformance harness).
 * The module loads asynchronously — await ready() before calling.
 *
 * This is a drop-in replacement for `import { stemmer } from 'stemmer'`, used as
 * a dependency of the forthcoming WASM TextIndex port.
 */
import createStemmerModule from '../lib/stemmer.wasm.mjs';

let Module = null;
let readyPromise = null;

/** Instantiate the WASM module (idempotent). */
export function ready() {
  if (!readyPromise) {
    readyPromise = createStemmerModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated. */
export function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) throw new Error('stemmer-wasm not initialized: await ready() before use');
  return Module;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Return the Porter stem of `value`. Matches stemmer@2.0.1 byte-for-byte for
 * ASCII words. Requires the module to be instantiated (await ready()).
 */
export function stemmer(value) {
  const M = requireModule();
  const bytes = encoder.encode(String(value));
  const len = bytes.length;
  // Worst case the stem length equals the input; +2 for a possible appended
  // 'e'/'i' and the NUL terminator the C side writes.
  const inPtr = M._malloc(len || 1);
  const outPtr = M._malloc(len + 2);
  try {
    if (len) M.HEAPU8.set(bytes, inPtr);
    const outLen = M._stemmer_stem(inPtr, len, outPtr);
    return decoder.decode(M.HEAPU8.slice(outPtr, outPtr + outLen));
  } finally {
    M._free(inPtr);
    M._free(outPtr);
  }
}

export default stemmer;
