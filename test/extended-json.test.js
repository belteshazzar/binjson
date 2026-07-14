import { describe, it, expect } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { ObjectId, Pointer } from '../src/binjson.js';
import { encode, decode } from '../client/extended-json.js';

await ready();

describe('extended-json', () => {
  it('round-trips a document with every wrapped type through real JSON.stringify/parse', () => {
    const id = new ObjectId();
    const doc = {
      _id: id,
      name: 'Ada',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      avatar: new Uint8Array([1, 2, 3, 255]),
      offset: new Pointer(12345),
      nested: { tags: ['a', 'b'], count: 3, active: true, note: null }
    };

    const text = JSON.stringify(encode(doc));
    const back = decode(JSON.parse(text));

    expect(back._id).toBeInstanceOf(ObjectId);
    expect(back._id.equals(id)).toBe(true);
    expect(back.createdAt).toBeInstanceOf(Date);
    expect(back.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(back.avatar).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.avatar)).toEqual([1, 2, 3, 255]);
    expect(back.offset).toBeInstanceOf(Pointer);
    expect(back.offset.valueOf()).toBe(12345);
    expect(back.nested).toEqual({ tags: ['a', 'b'], count: 3, active: true, note: null });
  });

  it('encodes the wire shape documented in cloud-rest-api.md', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011');
    const wire = encode({ _id: id, createdAt: new Date('2024-01-01T00:00:00.000Z') });
    expect(wire).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      createdAt: { $date: '2024-01-01T00:00:00.000Z' }
    });
  });

  it('leaves plain values (arrays, primitives, null) untouched', () => {
    const value = { a: 1, b: 'x', c: [1, 2, { d: null }], e: false };
    expect(decode(JSON.parse(JSON.stringify(encode(value))))).toEqual(value);
  });
});
