/**
 * Differential fuzz test: the WASM codec vs. the JS reference.
 *
 * A seeded PRNG makes every run reproducible (bump SEED to explore more).
 * For each random value we assert:
 *   1. wasmEncode(v) is byte-identical to refEncode(v)
 *   2. wasmDecode(refEncode(v)) reproduces v
 *   3. refDecode(wasmEncode(v)) reproduces v  (cross-codec interop)
 * Then we corrupt/truncate valid encodings and assert both codecs agree on
 * whether the input is decodable (both throw, or both return equal values).
 */
import { describe, it, expect } from 'vitest';
import * as ref from '../src/binjson.js';
import * as wasm from '../src/binjson-wasm.js';
import { ObjectId, Pointer } from '../src/binjson.js';

await wasm.ready();

const SEED = 0x9e3779b9;
const ITERATIONS = 2000;

// mulberry32 — small deterministic PRNG.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

// Coerce rich types to a comparable shape (and fold -0/NaN to stable values).
function normalize(v) {
  if (v instanceof ObjectId) return { __oid: v.toString() };
  if (v instanceof Pointer) return { __ptr: v.offset };
  if (v instanceof Date) return { __date: v.getTime() };
  if (v instanceof Uint8Array) return { __bin: hex(v) };
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = normalize(v[k]);
    return o;
  }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__nan';
    if (Object.is(v, -0)) return 0;
  }
  return v;
}

function randInt(rng, n) { return Math.floor(rng() * n); }

function randSafeInt(rng) {
  // Mix small values with large 64-bit-range safe integers.
  const pick = randInt(rng, 5);
  if (pick === 0) return randInt(rng, 512) - 256;
  if (pick === 1) return randInt(rng, 0x7fffffff) - 0x40000000;
  const big = Math.floor(rng() * Number.MAX_SAFE_INTEGER);
  return rng() < 0.5 ? big : -big;
}

function randString(rng) {
  const len = randInt(rng, 12);
  let s = '';
  for (let i = 0; i < len; i++) {
    const r = rng();
    if (r < 0.6) s += String.fromCharCode(0x20 + randInt(rng, 0x5e));      // ASCII
    else if (r < 0.85) s += String.fromCharCode(0x80 + randInt(rng, 0x700)); // 2-3 byte
    else s += String.fromCodePoint(0x1f300 + randInt(rng, 0x200));           // 4 byte
  }
  return s;
}

function randHex(rng, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[randInt(rng, 16)];
  return s;
}

function randValue(rng, depth) {
  const leaf = depth <= 0 ? 8 : 12;
  switch (randInt(rng, leaf)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return randSafeInt(rng);
    case 3: return (rng() - 0.5) * Math.pow(10, randInt(rng, 20) - 6) + 0.5; // non-integer
    case 4: return randString(rng);
    case 5: return new Date(randInt(rng, 8.64e15 * 2) - 8.64e15);
    case 6: return new Pointer(Math.floor(rng() * Number.MAX_SAFE_INTEGER));
    case 7: {
      const n = randInt(rng, 10);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = randInt(rng, 256);
      return b;
    }
    case 8: return new ObjectId(randHex(rng, 24));
    case 9: return rng() < 0.5 ? NaN : (rng() < 0.5 ? Infinity : -Infinity);
    case 10: {
      const n = randInt(rng, 6);
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(randValue(rng, depth - 1));
      return arr;
    }
    default: {
      const n = randInt(rng, 6);
      const obj = {};
      for (let i = 0; i < n; i++) obj[`k${i}_${randString(rng)}`] = randValue(rng, depth - 1);
      return obj;
    }
  }
}

function tryDecode(mod, bytes) {
  try { return { ok: true, val: normalize(mod.decode(bytes)) }; }
  catch { return { ok: false }; }
}

describe('WASM codec differential fuzz', () => {
  it(`encodes byte-identically and round-trips ${ITERATIONS} random values`, () => {
    const rng = makeRng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const v = randValue(rng, 5);
      const refBytes = ref.encode(v);
      const wasmBytes = wasm.encode(v);

      expect(hex(wasmBytes), `encode parity #${i}`).toBe(hex(refBytes));
      expect(normalize(wasm.decode(refBytes)), `wasmDecode(ref) #${i}`).toStrictEqual(normalize(v));
      expect(normalize(ref.decode(wasmBytes)), `refDecode(wasm) #${i}`).toStrictEqual(normalize(v));
    }
  });

  it('agrees with the reference on corrupted and truncated inputs', () => {
    const rng = makeRng(SEED ^ 0x1234);
    let mismatches = 0;
    for (let i = 0; i < 600; i++) {
      const original = ref.encode(randValue(rng, 4));

      // Truncation: always incomplete, both must reject.
      if (original.length > 1) {
        const cut = original.slice(0, 1 + randInt(rng, original.length - 1));
        const a = tryDecode(ref, cut);
        const b = tryDecode(wasm, cut);
        if (a.ok !== b.ok) mismatches++;
      }

      // Single-byte corruption: both codecs must reach the same verdict.
      const mutated = original.slice();
      mutated[randInt(rng, mutated.length)] ^= 1 << randInt(rng, 8);
      const a = tryDecode(ref, mutated);
      const b = tryDecode(wasm, mutated);
      if (a.ok !== b.ok) mismatches++;
      else if (a.ok && JSON.stringify(a.val) !== JSON.stringify(b.val)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});
