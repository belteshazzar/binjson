/**
 * End-to-end check of the WASM codec against the JS reference.
 *   - wasmEncode(v) is byte-identical to refEncode(v)
 *   - wasmDecode(refEncode(v)) reproduces v (types + values)
 *   - refDecode(wasmEncode(v)) reproduces v (cross-codec interop)
 *   - malformed inputs throw
 *
 * Run: node c/test-wasm.mjs
 */
import assert from 'node:assert';
import { encode as refEncode, decode as refDecode } from '../src/binjson.js';
import * as wasm from '../src/binjson-wasm.js';
import { ObjectId, Pointer } from '../src/binjson.js';

await wasm.ready();

let pass = 0;
const hex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

function normalize(v) {
  // Compare by structure, coercing the rich types to a stable shape.
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
  if (typeof v === 'number' && Number.isNaN(v)) return '__nan';
  return v;
}

function eq(label, a, b) {
  assert.deepStrictEqual(normalize(a), normalize(b), label);
}

const cases = [
  ['null', null],
  ['false', false],
  ['true', true],
  ['int', 42],
  ['int0', 0],
  ['intNeg', -1000000000000],
  ['maxSafe', Number.MAX_SAFE_INTEGER],
  ['minSafe', Number.MIN_SAFE_INTEGER],
  ['float', 3.5],
  ['floatNeg', -0.0001],
  ['nan', NaN],
  ['inf', Infinity],
  ['emptyStr', ''],
  ['str', 'hello'],
  ['utf8', 'héllo \u{1F600} мир'],
  ['date', new Date(1700000000000)],
  ['dateEpoch', new Date(0)],
  ['datePre1970', new Date(-5000000000)],
  ['ptr', new Pointer(65535)],
  ['ptr0', new Pointer(0)],
  ['oid', new ObjectId('507f1f77bcf86cd799439011')],
  ['bin', new Uint8Array([1, 2, 3, 255, 0, 128])],
  ['binEmpty', new Uint8Array([])],
  ['arr', [1, true, 'x', null]],
  ['arrEmpty', []],
  ['obj', { a: 1, bee: 'z' }],
  ['objEmpty', {}],
  ['nested', { list: [{ n: null }, []], flag: false, tags: ['a', 'b'] }],
  ['deepArr', [[[[[1]]]]]],
  ['mixedObj', { id: new ObjectId('507f1f77bcf86cd799439011'), when: new Date(1e12), at: new Pointer(4096), blob: new Uint8Array([9, 8, 7]) }]
];

for (const [name, value] of cases) {
  const refBytes = refEncode(value);
  const wasmBytes = wasm.encode(value);
  assert.strictEqual(hex(wasmBytes), hex(refBytes), `encode bytes differ: ${name}`);

  eq(`wasmDecode(ref): ${name}`, wasm.decode(refBytes), value);
  eq(`refDecode(wasm): ${name}`, refDecode(wasmBytes), value);
  eq(`wasm roundtrip: ${name}`, wasm.decode(wasmBytes), value);
  pass++;
}

// Malformed inputs should throw (bounds / type / range guards live in C).
const bad = [
  ['empty', new Uint8Array([])],
  ['badType', new Uint8Array([0x0a])],
  ['truncInt', new Uint8Array([0x03, 1, 2, 3])],
  ['truncStr', new Uint8Array([0x05, 10, 0, 0, 0, 65])],
  ['intRange', new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0x20, 0])],
  ['ptrRange', new Uint8Array([0x08, 0, 0, 0, 0, 0, 0, 0x20, 0])]
];
for (const [name, bytes] of bad) {
  assert.throws(() => wasm.decode(bytes), `expected throw: ${name}`);
  pass++;
}

// Large payload to exercise heap growth + buffer reuse across calls.
const big = { data: 'x'.repeat(200000), nums: Array.from({ length: 5000 }, (_, i) => i) };
assert.strictEqual(hex(wasm.encode(big)), hex(refEncode(big)), 'big encode');
eq('big roundtrip', wasm.decode(wasm.encode(big)), big);
pass++;

console.log(`WASM codec OK: ${pass} checks passed (${cases.length} value cases, byte-parity + cross-codec interop)`);
