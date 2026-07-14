/**
 * client/extended-json.js — the wire format for documents crossing the
 * REST/WebSocket boundary (see docs/cloud-rest-api.md's "Wire format for
 * documents"). Plain JSON can't round-trip ObjectId/Date/binary, so this
 * reuses MongoDB's own Extended JSON (relaxed mode) convention instead of
 * inventing one, plus one binjson-specific extension (`$pointer`) for the
 * `Pointer` type, which has no Mongo equivalent.
 *
 * Lives under client/, not service/, even though service/rest-gateway.js
 * uses it too: this is a wire-format concern shared by both ends of the
 * connection, not a server-internal detail, and client/ is the piece
 * meant to eventually stand alone as a publishable package a server
 * dependency can point at -- the reverse (client depending on service/)
 * would be backwards.
 *
 * Operates on already-parsed/to-be-serialized JS values, not raw text, so
 * it composes with JSON.parse/JSON.stringify: `decode(JSON.parse(text))`
 * and `JSON.stringify(encode(value))`.
 */
import { ObjectId, Pointer } from '../src/binjson.js';

/** JS value (possibly containing ObjectId/Date/Pointer/Uint8Array) -> plain JSON-safe value. */
function encode(value) {
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Pointer) return { $pointer: String(value.offset) };
  if (value instanceof Uint8Array) return { $binary: { base64: Buffer.from(value).toString('base64'), subType: '00' } };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

/** Plain JSON value (possibly containing $oid/$date/$pointer/$binary wrappers) -> JS value. */
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (typeof value.$oid === 'string') return new ObjectId(value.$oid);
    if (typeof value.$date === 'string') return new Date(value.$date);
    if (typeof value.$pointer === 'string') return new Pointer(Number(value.$pointer));
    if (value.$binary && typeof value.$binary.base64 === 'string') {
      return new Uint8Array(Buffer.from(value.$binary.base64, 'base64'));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

export { encode, decode };
