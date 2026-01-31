import { expect, describe, it, beforeEach, afterEach, beforeAll } from 'vitest';
import { BPlusTreePtr } from '../src/bplustree-ptr.js';
import { deleteFile, getFileHandle } from '../src/binjson.js';

// Set up node-opfs for Node.js environment
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

describe.skipIf(!hasOPFS)('BPlusTreePtr', function() {
    let testFileCounter = 0;
    let rootDirHandle = null;

    beforeAll(async () => {
      if (navigator.storage && navigator.storage.getDirectory) {
        rootDirHandle = await navigator.storage.getDirectory();
      }
    });

    function getTestFilename() {
        return `test-bplustree-ptr-${Date.now()}-${testFileCounter++}.bj`;
    }

    async function createTestTree(order = 3) {
        const filename = getTestFilename();
        const fileHandle = await getFileHandle(rootDirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        const tree = new BPlusTreePtr(syncHandle, order, rootDirHandle);
        tree._testFilename = filename;
        return tree;
    }

    async function cleanupFile(filename) {
            if (rootDirHandle) {
              await deleteFile(rootDirHandle, filename);
            }
    }

    describe('Constructor', function() {
        let tree;

        afterEach(async function() {
            if (tree && tree.isOpen) {
                await tree.close();
            }
            if (tree && tree._testFilename) {
              await cleanupFile(tree._testFilename);
            }
        });

        it('should create an empty tree with default order', async function() {
            tree = await createTestTree();
            await tree.open();
            expect(tree.isEmpty()).toBe(true);
            expect(tree.size()).toBe(0);
        });

        it('should create an empty tree with custom order', async function() {
            tree = await createTestTree(5);
            await tree.open();
            expect(tree.isEmpty()).toBe(true);
            expect(tree.order).toBe(5);
        });

        it('should throw error for invalid order', async function() {
            const fileHandle = await getFileHandle(rootDirHandle, getTestFilename(), { create: true });
            const syncHandle = await fileHandle.createSyncAccessHandle();
            expect(() => new BPlusTreePtr(syncHandle, 2)).toThrow('B+ tree order must be at least 3');
            expect(() => new BPlusTreePtr(syncHandle, 1)).toThrow('B+ tree order must be at least 3');
            await syncHandle.close();
        });
    });

    describe('Add and Search', function() {
        let tree;

        beforeEach(async function() {
            tree = await createTestTree(3);
            await tree.open();
        });

        afterEach(async function() {
            if (tree && tree.isOpen) {
                await tree.close();
            }
            if (tree && tree._testFilename) {
              await cleanupFile(tree._testFilename);
            }
        });

        it('should add a single key-value pair', async function() {
            await tree.add(10, 'ten');
            expect(tree.size()).toBe(1);
            expect(await tree.search(10)).toBe('ten');
        });

        it('should add multiple key-value pairs', async function() {
            await tree.add(10, 'ten');
            await tree.add(20, 'twenty');
            await tree.add(5, 'five');
            await tree.add(15, 'fifteen');

            expect(tree.size()).toBe(4);
            expect(await tree.search(10)).toBe('ten');
            expect(await tree.search(20)).toBe('twenty');
            expect(await tree.search(5)).toBe('five');
            expect(await tree.search(15)).toBe('fifteen');
        });

        it('should return undefined for non-existent keys', async function() {
            await tree.add(10, 'ten');
            expect(await tree.search(20)).toBeUndefined();
            expect(await tree.search(5)).toBeUndefined();
        });

        it('should handle adding keys in ascending order', async function() {
            for (let i = 1; i <= 10; i++) {
                await tree.add(i, `value${i}`);
            }

            expect(tree.size()).toBe(10);
            for (let i = 1; i <= 10; i++) {
                expect(await tree.search(i)).toBe(`value${i}`);
            }
        });

        it('should handle complex object values', async function() {
            const obj1 = {name: 'Alice', age: 30, tags: ['a', 'b', 'c']};
            const obj2 = {name: 'Bob', age: 25, tags: ['x', 'y', 'z']};

            await tree.add(1, obj1);
            await tree.add(2, obj2);

            expect(await tree.search(1)).toEqual(obj1);
            expect(await tree.search(2)).toEqual(obj2);
        });

        it('should handle large values efficiently', async function() {
            const largeValue = {
                id: 1,
                data: Array(100).fill(0).map((_, i) => ({ index: i, value: `data${i}` }))
            };

            await tree.add(1, largeValue);
            expect(await tree.search(1)).toEqual(largeValue);
        });

        it('should handle updating existing keys', async function() {
            await tree.add(10, 'ten');
            await tree.add(10, 'TEN');
            
            const result = await tree.search(10);
            expect(result).toBe('TEN');
        });
    });

    describe('Delete', function() {
        let tree;

        beforeEach(async function() {
            tree = await createTestTree(3);
            await tree.open();
        });

        afterEach(async function() {
            if (tree && tree.isOpen) {
                await tree.close();
            }
            if (tree && tree._testFilename) {
              await cleanupFile(tree._testFilename);
            }
        });

        it('should delete a key from tree with single element', async function() {
            await tree.add(10, 'ten');
            await tree.delete(10);
            expect(tree.size()).toBe(0);
            expect(await tree.search(10)).toBeUndefined();
        });

        it('should delete a key from tree with multiple elements', async function() {
            await tree.add(10, 'ten');
            await tree.add(20, 'twenty');
            await tree.add(5, 'five');

            await tree.delete(10);
            expect(tree.size()).toBe(2);
            expect(await tree.search(10)).toBeUndefined();
            expect(await tree.search(20)).toBe('twenty');
            expect(await tree.search(5)).toBe('five');
        });
    });

    describe('toArray', function() {
        let tree;

        beforeEach(async function() {
            tree = await createTestTree(3);
            await tree.open();
        });

        afterEach(async function() {
            if (tree && tree.isOpen) {
                await tree.close();
            }
            if (tree && tree._testFilename) {
              await cleanupFile(tree._testFilename);
            }
        });

        it('should return empty array for empty tree', async function() {
            expect(await tree.toArray()).toEqual([]);
        });

        it('should return all elements in sorted order', async function() {
            const keys = [5, 2, 8, 1, 9, 3];
            for (const key of keys) {
                await tree.add(key, `value${key}`);
            }

            const result = await tree.toArray();
            expect(result.length).toBe(6);

            // Verify sorted order
            for (let i = 0; i < result.length - 1; i++) {
                expect(result[i].key).toBeLessThan(result[i + 1].key);
            }

            // Verify content
            expect(result).toEqual([
                {key: 1, value: 'value1'},
                {key: 2, value: 'value2'},
                {key: 3, value: 'value3'},
                {key: 5, value: 'value5'},
                {key: 8, value: 'value8'},
                {key: 9, value: 'value9'}
            ]);
        });
    });

    describe('rangeSearch', function() {
        let tree;

        beforeEach(async function() {
            tree = await createTestTree(3);
            await tree.open();
            for (let i = 1; i <= 10; i++) {
                await tree.add(i, `value${i}`);
            }
        });

        afterEach(async function() {
            if (tree && tree.isOpen) {
                await tree.close();
            }
            if (tree && tree._testFilename) {
              await cleanupFile(tree._testFilename);
            }
        });

        it('should find all elements in range', async function() {
            const result = await tree.rangeSearch(3, 7);
            expect(result.length).toBe(5);
            expect(result.map(r => r.key)).toEqual([3, 4, 5, 6, 7]);
        });

        it('should find single element range', async function() {
            const result = await tree.rangeSearch(5, 5);
            expect(result.length).toBe(1);
            expect(result[0].key).toBe(5);
        });
    });
});
