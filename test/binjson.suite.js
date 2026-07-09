/**
 * Shared binjson test suite, parameterized by codec.
 *
 * Both test/binjson.test.js (pure-JS codec) and test/binjson-wasm.test.js
 * (WASM codec) call these with their respective module so the identical set of
 * assertions runs against each. Keeping one copy prevents the suites drifting.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * Wire up OPFS for Node via node-opfs (or detect native browser OPFS).
 * Returns { hasOPFS } so file-backed tests can skip when unavailable.
 */
export async function bootstrapOPFS() {
  let hasOPFS = false;
  try {
    const nodeOpfs = await import('node-opfs');
    if (nodeOpfs.navigator && typeof global !== 'undefined') {
      Object.defineProperty(global, 'navigator', {
        value: nodeOpfs.navigator,
        writable: true,
        configurable: true
      });
      hasOPFS = true;
    }
  } catch (e) {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      hasOPFS = true;
    }
  }
  return { hasOPFS };
}

/**
 * The core encode/decode conformance suite.
 * @param {string} label - prefix distinguishing this run in test output
 * @param {object} codec - { TYPE, ObjectId, Pointer, encode, decode }
 */
export function runCodecSuite(label, codec) {
  const { TYPE, ObjectId, Pointer, encode, decode } = codec;

  describe(`${label}: Binary JSON Encoder/Decoder`, () => {
    describe('NULL', () => {
      it('should encode null to 1 byte', () => {
        const encoded = encode(null);
        expect(encoded).toHaveLength(1);
        expect(encoded[0]).toBe(TYPE.NULL);
      });

      it('should round-trip null', () => {
        expect(decode(encode(null))).toBe(null);
      });
    });

    describe('FALSE', () => {
      it('should encode false to 1 byte', () => {
        const encoded = encode(false);
        expect(encoded).toHaveLength(1);
        expect(encoded[0]).toBe(TYPE.FALSE);
      });

      it('should round-trip false', () => {
        expect(decode(encode(false))).toBe(false);
      });
    });

    describe('TRUE', () => {
      it('should encode true to 1 byte', () => {
        const encoded = encode(true);
        expect(encoded).toHaveLength(1);
        expect(encoded[0]).toBe(TYPE.TRUE);
      });

      it('should round-trip true', () => {
        expect(decode(encode(true))).toBe(true);
      });
    });

    describe('INT', () => {
      it('should encode integer to 9 bytes', () => {
        const encoded = encode(42);
        expect(encoded).toHaveLength(9);
        expect(encoded[0]).toBe(TYPE.INT);
      });

      it('should round-trip positive integer', () => {
        expect(decode(encode(42))).toBe(42);
      });

      it('should round-trip negative integer', () => {
        expect(decode(encode(-123))).toBe(-123);
      });

      it('should round-trip max 32-bit integer', () => {
        expect(decode(encode(2147483647))).toBe(2147483647);
      });

      it('should round-trip min 32-bit integer', () => {
        expect(decode(encode(-2147483648))).toBe(-2147483648);
      });
    });

    describe('FLOAT', () => {
      it('should encode float to 9 bytes', () => {
        const encoded = encode(3.14159);
        expect(encoded).toHaveLength(9);
        expect(encoded[0]).toBe(TYPE.FLOAT);
      });

      it('should round-trip float', () => {
        const value = 3.14159;
        const decoded = decode(encode(value));
        expect(Math.abs(decoded - value)).toBeLessThan(0.00001);
      });

      it('should round-trip large float', () => {
        expect(decode(encode(1e100))).toBe(1e100);
      });

      it('should round-trip negative float', () => {
        expect(decode(encode(-2.5))).toBe(-2.5);
      });
    });

    describe('STRING', () => {
      it('should have correct type byte', () => {
        expect(encode('hello')[0]).toBe(TYPE.STRING);
      });

      it('should round-trip simple string', () => {
        expect(decode(encode('hello'))).toBe('hello');
      });

      it('should round-trip empty string', () => {
        expect(decode(encode(''))).toBe('');
      });

      it('should round-trip unicode string', () => {
        const text = 'Hello 世界 🌍';
        expect(decode(encode(text))).toBe(text);
      });
    });

    describe('ObjectId', () => {
      it('should convert to string', () => {
        const oid = new ObjectId('507f1f77bcf86cd799439011');
        expect(oid.toString()).toBe('507f1f77bcf86cd799439011');
      });

      it('should encode to 13 bytes', () => {
        const oid = new ObjectId('507f1f77bcf86cd799439011');
        const encoded = encode(oid);
        expect(encoded).toHaveLength(13);
        expect(encoded[0]).toBe(TYPE.OID);
      });

      it('should round-trip ObjectId', () => {
        const oid = new ObjectId('507f1f77bcf86cd799439011');
        const decoded = decode(encode(oid));
        expect(decoded).toBeInstanceOf(ObjectId);
        expect(decoded.toString()).toBe('507f1f77bcf86cd799439011');
      });

      it('should throw on invalid ObjectId', () => {
        expect(() => new ObjectId('invalid')).toThrow();
      });

      it('should validate ObjectId format', () => {
        expect(ObjectId.isValid('507f1f77bcf86cd799439011')).toBe(true);
        expect(ObjectId.isValid('invalid')).toBe(false);
      });
    });

    describe('DATE', () => {
      it('should encode date to 9 bytes', () => {
        const date = new Date('2023-01-15T12:30:45.000Z');
        const encoded = encode(date);
        expect(encoded).toHaveLength(9);
        expect(encoded[0]).toBe(TYPE.DATE);
      });

      it('should round-trip date', () => {
        const date = new Date('2023-01-15T12:30:45.000Z');
        const decoded = decode(encode(date));
        expect(decoded).toBeInstanceOf(Date);
        expect(decoded.getTime()).toBe(date.getTime());
      });

      it('should round-trip epoch date', () => {
        expect(decode(encode(new Date(0))).getTime()).toBe(0);
      });

      it('should round-trip future date', () => {
        const date = new Date('2099-12-31T23:59:59.999Z');
        expect(decode(encode(date)).getTime()).toBe(date.getTime());
      });
    });

    describe('POINTER', () => {
      it('should get value via valueOf()', () => {
        expect(new Pointer(1024).valueOf()).toBe(1024);
      });

      it('should convert to string', () => {
        expect(new Pointer(1024).toString()).toBe('1024');
      });

      it('should encode to 9 bytes', () => {
        const encoded = encode(new Pointer(1024));
        expect(encoded).toHaveLength(9);
        expect(encoded[0]).toBe(TYPE.POINTER);
      });

      it('should round-trip pointer', () => {
        const decoded = decode(encode(new Pointer(1024)));
        expect(decoded).toBeInstanceOf(Pointer);
        expect(decoded.valueOf()).toBe(1024);
      });

      it('should round-trip zero pointer', () => {
        expect(decode(encode(new Pointer(0))).valueOf()).toBe(0);
      });

      it('should round-trip max safe integer pointer', () => {
        const ptr = new Pointer(9007199254740991); // MAX_SAFE_INTEGER
        expect(decode(encode(ptr)).valueOf()).toBe(9007199254740991);
      });

      it('should throw on negative offset', () => {
        expect(() => new Pointer(-1)).toThrow();
      });

      it('should throw on non-number offset', () => {
        expect(() => new Pointer('invalid')).toThrow();
      });

      it('should throw on non-integer offset', () => {
        expect(() => new Pointer(3.14)).toThrow();
      });

      it('should compare equal pointers', () => {
        expect(new Pointer(100).equals(new Pointer(100))).toBe(true);
      });

      it('should compare different pointers as not equal', () => {
        expect(new Pointer(100).equals(new Pointer(200))).toBe(false);
      });
    });

    describe('BINARY', () => {
      it('should have correct type byte', () => {
        expect(encode(new Uint8Array([1, 2, 3, 4, 5]))[0]).toBe(TYPE.BINARY);
      });

      it('should encode to correct size', () => {
        // 1 byte type + 4 bytes length + 5 bytes data = 10 bytes
        expect(encode(new Uint8Array([1, 2, 3, 4, 5]))).toHaveLength(10);
      });

      it('should round-trip simple binary data', () => {
        const binary = new Uint8Array([1, 2, 3, 4, 5]);
        const decoded = decode(encode(binary));
        expect(decoded).toBeInstanceOf(Uint8Array);
        expect(decoded).toEqual(binary);
      });

      it('should round-trip empty binary data', () => {
        const binary = new Uint8Array([]);
        const decoded = decode(encode(binary));
        expect(decoded).toBeInstanceOf(Uint8Array);
        expect(decoded).toEqual(binary);
        expect(decoded).toHaveLength(0);
      });

      it('should round-trip binary data with all byte values', () => {
        const binary = new Uint8Array(256);
        for (let i = 0; i < 256; i++) binary[i] = i;
        expect(decode(encode(binary))).toEqual(binary);
      });

      it('should round-trip large binary data', () => {
        const size = 10000;
        const binary = new Uint8Array(size);
        for (let i = 0; i < size; i++) binary[i] = i % 256;
        expect(decode(encode(binary))).toEqual(binary);
      });

      it('should handle binary data in object', () => {
        const data = { name: 'test', buffer: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]) };
        const decoded = decode(encode(data));
        expect(decoded.name).toBe('test');
        expect(decoded.buffer).toBeInstanceOf(Uint8Array);
        expect(decoded.buffer).toEqual(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
      });

      it('should handle binary data in array', () => {
        const binary1 = new Uint8Array([1, 2, 3]);
        const binary2 = new Uint8Array([4, 5, 6]);
        const decoded = decode(encode([binary1, 'text', binary2]));
        expect(decoded).toHaveLength(3);
        expect(decoded[0]).toEqual(binary1);
        expect(decoded[1]).toBe('text');
        expect(decoded[2]).toEqual(binary2);
      });
    });

    describe('ARRAY', () => {
      it('should have correct type byte', () => {
        expect(encode([1, 2, 3])[0]).toBe(TYPE.ARRAY);
      });

      it('should round-trip simple array', () => {
        expect(decode(encode([1, 2, 3]))).toEqual([1, 2, 3]);
      });

      it('should round-trip empty array', () => {
        expect(decode(encode([]))).toEqual([]);
      });

      it('should round-trip mixed type array', () => {
        const arr = [1, 'hello', true, null, 3.14];
        expect(decode(encode(arr))).toEqual(arr);
      });

      it('should round-trip nested array', () => {
        const arr = [[1, 2], [3, 4]];
        expect(decode(encode(arr))).toEqual(arr);
      });
    });

    describe('OBJECT', () => {
      it('should have correct type byte', () => {
        expect(encode({ a: 1, b: 2 })[0]).toBe(TYPE.OBJECT);
      });

      it('should round-trip simple object', () => {
        expect(decode(encode({ a: 1, b: 2 }))).toEqual({ a: 1, b: 2 });
      });

      it('should round-trip empty object', () => {
        expect(decode(encode({}))).toEqual({});
      });

      it('should round-trip mixed type object', () => {
        const obj = { num: 42, str: 'test', bool: true, nil: null, float: 3.14 };
        expect(decode(encode(obj))).toEqual(obj);
      });

      it('should round-trip nested object', () => {
        const obj = { user: { name: 'John', age: 30 }, items: [1, 2, 3] };
        expect(decode(encode(obj))).toEqual(obj);
      });
    });

    describe('Complex Structures', () => {
      it('should round-trip complex nested structure', () => {
        const data = {
          name: 'Test Document',
          count: 42,
          price: 99.99,
          active: true,
          tags: ['javascript', 'binary', 'json'],
          metadata: {
            created: 1234567890,
            updated: null,
            nested: { deep: 'value' }
          },
          items: [
            { id: 1, name: 'Item 1' },
            { id: 2, name: 'Item 2' }
          ]
        };
        expect(decode(encode(data))).toEqual(data);
      });
    });

    describe('Pointer with File Offset Simulation', () => {
      it('should handle pointer in record', () => {
        const record = {
          type: 'reference',
          dataPointer: new Pointer(1024),
          metadata: 'This record points to data at offset 1024'
        };
        const decoded = decode(encode(record));
        expect(decoded.dataPointer).toBeInstanceOf(Pointer);
        expect(decoded.dataPointer.valueOf()).toBe(1024);
      });
    });

    describe('Error Handling', () => {
      it('should throw on unknown type byte', () => {
        expect(() => decode(new Uint8Array([0xFF]))).toThrow();
      });

      it('should throw on incomplete INT', () => {
        expect(() => decode(new Uint8Array([TYPE.INT, 0x00]))).toThrow();
      });

      it('should throw on incomplete STRING', () => {
        expect(() => decode(new Uint8Array([TYPE.STRING, 0x0A, 0x00, 0x00, 0x00]))).toThrow();
      });
    });
  });
}

/**
 * File-backed (OPFS) suite exercising the re-exported BinJsonFile.
 * @param {string} label
 * @param {object} codec - { BinJsonFile, deleteFile, getFileHandle }
 * @param {boolean} hasOPFS
 */
export function runFileSuite(label, codec, hasOPFS) {
  const { BinJsonFile, deleteFile, getFileHandle } = codec;

  describe.skipIf(!hasOPFS)(`${label}: BinJsonFile`, () => {
    let rootDirHandle = null;
    // Label-scoped filenames so parallel codec suites don't share OPFS files.
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const fileA = `test-binjsonfile-${slug}.bj`;
    const fileB = `test-binjsonfile2-${slug}.bj`;
    const testFiles = [fileA, fileB];

    beforeAll(async () => {
      if (navigator.storage && navigator.storage.getDirectory) {
        rootDirHandle = await navigator.storage.getDirectory();
      }
    });

    afterEach(async () => {
      if (rootDirHandle) {
        for (const filename of testFiles) {
          await deleteFile(rootDirHandle, filename);
        }
      }
    });

    it('should write and read file', async () => {
      const fileHandle = await getFileHandle(rootDirHandle, fileA, { create: true });
      const syncHandle = await fileHandle.createSyncAccessHandle();
      const file = new BinJsonFile(syncHandle);

      const data = {
        name: 'Test Document',
        count: 42,
        price: 99.99,
        active: true,
        tags: ['javascript', 'binary', 'json'],
        metadata: { created: 1234567890, updated: null }
      };

      file.write(data);
      file.flush();

      const readData = file.read();
      expect(readData.name).toBe('Test Document');
      expect(readData.count).toBe(42);
      expect(readData.price).toBe(99.99);
      expect(readData.active).toBe(true);
      expect(readData.tags).toHaveLength(3);
      expect(readData.metadata.updated).toBe(null);

      await syncHandle.close();
    });

    it('should check file existence', async () => {
      const fileHandle = await getFileHandle(rootDirHandle, fileA, { create: true });
      const syncHandle = await fileHandle.createSyncAccessHandle();
      const file = new BinJsonFile(syncHandle);

      file.write({ test: 'data' });
      file.flush();
      expect(fileHandle).toBeDefined();

      try {
        await getFileHandle(rootDirHandle, 'nonexistent.bj');
        expect(true).toBe(false);
      } catch (error) {
        expect(error.name).toBe('NotFoundError');
      }

      await syncHandle.close();
    });

    it('should append and scan records', async () => {
      const fileHandle = await getFileHandle(rootDirHandle, fileB, { create: true });
      const syncHandle = await fileHandle.createSyncAccessHandle();
      const file = new BinJsonFile(syncHandle);

      file.write({ id: 1, name: 'First' });
      file.flush();
      file.append({ id: 2, name: 'Second' });
      file.flush();

      const records = [];
      for (const { value: record } of file.scan()) records.push(record);

      expect(records).toHaveLength(2);
      expect(records[0].id).toBe(1);
      expect(records[1].id).toBe(2);

      await syncHandle.close();
    });

    it('should delete file', async () => {
      const fileHandle = await getFileHandle(rootDirHandle, fileA, { create: true });
      const syncHandle = await fileHandle.createSyncAccessHandle();
      const file = new BinJsonFile(syncHandle);

      file.write({ test: 'data' });
      file.flush();
      await syncHandle.close();
      await deleteFile(rootDirHandle, fileA);

      try {
        await getFileHandle(rootDirHandle, fileA);
        expect(true).toBe(false);
      } catch (error) {
        expect(error.name).toBe('NotFoundError');
      }
    });
  });
}
