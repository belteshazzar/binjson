/**
 * BPlusTree - Persistent immutable B+ tree with BinJsonFile storage
 * 
 * Usage pattern:
 *   const tree = new BPlusTree('tree.bj');
 *   await tree.open();
 *   await tree.add(key, value);
 *   await tree.close();
 */

import { BinJsonFile, Pointer, getFileHandle, deleteFile } from './binjson.js';

/**
 * Node for persistent storage
 * @private
 */
class NodeData {
    /**
     * Creates a node data object for serialization
     * @param {number} id - Unique node ID
     * @param {boolean} isLeaf - Leaf flag
     * @param {Array} keys - Key array
     * @param {Array} values - Value array (leaf nodes)
     * @param {Array} children - Child pointers (internal nodes)
     * @param {Pointer} next - Pointer to next leaf
     */
    constructor(id, isLeaf, keys, values, children, next) {
        this.id = id;
        this.isLeaf = isLeaf;
        this.keys = keys;
        this.values = values;
        this.children = children;
        for (let v of children) {
            if (!(v instanceof Pointer)) {
                throw new Error('Children must be Pointer objects');
            }
        }
        this.next = next;
    }
}

/**
 * Persistent immutable B+ tree with append-only file storage
 */
export class BPlusTree {
    /**
     * Creates a new persistent B+ tree
     * @param {FileSystemSyncAccessHandle} syncHandle - Sync access handle to storage file
     * @param {number} order - Tree order (default: 3)
     */
    constructor(syncHandle, order = 3) {
        if (order < 3) {
            throw new Error('B+ tree order must be at least 3');
        }
        this.file = new BinJsonFile(syncHandle);
        this.order = order;
        this.minKeys = Math.ceil(order / 2) - 1;
        
        this.isOpen = false;
        
        // Metadata
        this.rootPointer = null;
        this.nextNodeId = 0;
        this._size = 0;
    }

    /**
     * Open the tree (load or initialize metadata)
     */
    async open() {
        if (this.isOpen) {
            throw new Error('Tree is already open');
        }

        // Check if file has content
        const fileSize = this.file.getFileSize();
        const exists = fileSize > 0;

        if (exists) {
            this._loadMetadata();
        } else {
            this._initializeNewTree();
        }

        this.isOpen = true;
    }

    /**
     * Close the tree and save metadata
     */
    async close() {
        if (this.isOpen) {
            if (this.file && this.file.syncAccessHandle) {
                this.file.flush();
                await this.file.syncAccessHandle.close();
            }
            this.isOpen = false;
        }
    }

    /**
     * Initialize a new empty tree
     */
    _initializeNewTree() {
        const rootNode = new NodeData(0, true, [], [], [], null);
        this.nextNodeId = 1;
        this._size = 0;

        const rootPointer = this._saveNode(rootNode);
        this.rootPointer = rootPointer;

        this._saveMetadata();
    }

    /**
     * Save metadata to file
     */
    _saveMetadata() {
        const metadata = {
            version: 1,
            maxEntries: this.order,  // Renamed to match RTree size
            minEntries: this.minKeys,  // Renamed to match RTree size
            size: this._size,
            rootPointer: this.rootPointer,
            nextId: this.nextNodeId  // Renamed to match RTree size
        };

        this.file.append(metadata);
    }

    /**
     * Load metadata from file
     */
    _loadMetadata() {
        const fileSize = this.file.getFileSize();
        // Metadata object has 6 INT fields (now encoded as 8-byte ints) plus keys
        const METADATA_SIZE = 135;
        
        if (fileSize < METADATA_SIZE) {
            throw new Error('Invalid tree file');
        }

        const metadataOffset = fileSize - METADATA_SIZE;
        const metadata = this.file.read(metadataOffset);

        if (!metadata || typeof metadata.maxEntries === 'undefined') {
            throw new Error(`Failed to read metadata: missing required fields`);
        }

        this.order = metadata.maxEntries;
        this.minKeys = metadata.minEntries;
        this._size = metadata.size;
        this.nextNodeId = metadata.nextId;
        this.rootPointer = metadata.rootPointer;
    }

    /**
     * Save a node to disk
     */
    _saveNode(node) {
        const offset = this.file.getFileSize();
        this.file.append(node);
        return new Pointer(offset);
    }

    /**
     * Load a node from disk
     */
    _loadNode(pointer) {
        if (!(pointer instanceof Pointer)) {
            throw new Error('Expected Pointer object');
        }

        const data = this.file.read(pointer);
        return new NodeData(
            data.id,
            data.isLeaf,
            data.keys,
            data.values,
            data.children,
            data.next
        );
    }

    /**
     * Load root node
     */
    _loadRoot() {
        return this._loadNode(this.rootPointer);
    }

    /**
     * Search for a key
     */
    search(key) {
        const root = this._loadRoot();
        return this._searchNode(root, key);
    }

    /**
     * Internal search
     */
    _searchNode(node, key) {
        if (node.isLeaf) {
            for (let i = 0; i < node.keys.length; i++) {
                if (key === node.keys[i]) {
                    return node.values[i];
                }
            }
            return undefined;
        } else {
            let i = 0;
            while (i < node.keys.length && key >= node.keys[i]) {
                i++;
            }
            const child = this._loadNode(node.children[i]);
            return this._searchNode(child, key);
        }
    }

    /**
     * Insert a key-value pair
     */
    add(key, value) {
        const root = this._loadRoot();
        const result = this._addToNode(root, key, value);

        let newRoot;
        if (result.newNode) {
            newRoot = result.newNode;
        } else {
            // Split occurred - save the split nodes and create new root with pointers
            const leftPointer = this._saveNode(result.left);
            const rightPointer = this._saveNode(result.right);
            newRoot = new NodeData(
                this.nextNodeId++,
                false,
                [result.splitKey],
                [],
                [leftPointer, rightPointer],
                null
            );
        }

        const rootPointer = this._saveNode(newRoot);
        this.rootPointer = rootPointer;

        this._size++;
        this._saveMetadata();
    }

    /**
     * Internal add
     */
    _addToNode(node, key, value) {
        if (node.isLeaf) {
            const keys = [...node.keys];
            const values = [...node.values];

            const existingIdx = keys.indexOf(key);
            if (existingIdx !== -1) {
                values[existingIdx] = value;
                return {
                    newNode: new NodeData(node.id, true, keys, values, [], null)
                };
            }

            let insertIdx = 0;
            while (insertIdx < keys.length && key > keys[insertIdx]) {
                insertIdx++;
            }
            keys.splice(insertIdx, 0, key);
            values.splice(insertIdx, 0, value);

            if (keys.length < this.order) {
                return {
                    newNode: new NodeData(node.id, true, keys, values, [], null)
                };
            } else {
                const mid = Math.ceil(keys.length / 2);
                const leftKeys = keys.slice(0, mid);
                const leftValues = values.slice(0, mid);
                const rightKeys = keys.slice(mid);
                const rightValues = values.slice(mid);

                const rightNode = new NodeData(this.nextNodeId++, true, rightKeys, rightValues, [], null);
                const leftNode = new NodeData(node.id, true, leftKeys, leftValues, [], null);

                return {
                    left: leftNode,
                    right: rightNode,
                    splitKey: rightKeys[0]
                };
            }
        } else {
            const keys = [...node.keys];
            const children = [...node.children];

            let childIdx = 0;
            while (childIdx < keys.length && key >= keys[childIdx]) {
                childIdx++;
            }

            const childNode = this._loadNode(children[childIdx]);
            const result = this._addToNode(childNode, key, value);

            if (result.newNode) {
                const newChildPointer = this._saveNode(result.newNode);
                children[childIdx] = newChildPointer;
                return {
                    newNode: new NodeData(node.id, false, keys, [], children, null)
                };
            } else {
                const leftPointer = this._saveNode(result.left);
                const rightPointer = this._saveNode(result.right);

                keys.splice(childIdx, 0, result.splitKey);
                children.splice(childIdx, 1, leftPointer, rightPointer);

                if (keys.length < this.order) {
                    return {
                        newNode: new NodeData(node.id, false, keys, [], children, null)
                    };
                } else {
                    const mid = Math.ceil(keys.length / 2) - 1;
                    const splitKey = keys[mid];
                    const leftKeys = keys.slice(0, mid);
                    const rightKeys = keys.slice(mid + 1);
                    const leftChildren = children.slice(0, mid + 1);
                    const rightChildren = children.slice(mid + 1);

                    const leftNode = new NodeData(node.id, false, leftKeys, [], leftChildren, null);
                    const rightNode = new NodeData(this.nextNodeId++, false, rightKeys, [], rightChildren, null);

                    return {
                        left: leftNode,
                        right: rightNode,
                        splitKey: splitKey
                    };
                }
            }
        }
    }

    /**
     * Delete a key
     */
    delete(key) {
        const root = this._loadRoot();
        const newRoot = this._deleteFromNode(root, key);

        if (!newRoot) {
            return; // Key not found
        }

        let finalRoot = newRoot;
        if (finalRoot.keys.length === 0 && !finalRoot.isLeaf && finalRoot.children.length > 0) {
            finalRoot = this._loadNode(finalRoot.children[0]);
        }

        const rootPointer = this._saveNode(finalRoot);
        this.rootPointer = rootPointer;

        this._size--;
        this._saveMetadata();
    }

    /**
     * Internal delete
     */
    _deleteFromNode(node, key) {
        if (node.isLeaf) {
            const keyIndex = node.keys.indexOf(key);

            if (keyIndex === -1) {
                return null;
            }

            const newKeys = [...node.keys];
            const newValues = [...node.values];
            newKeys.splice(keyIndex, 1);
            newValues.splice(keyIndex, 1);

            return new NodeData(node.id, true, newKeys, newValues, [], node.next);
        } else {
            let i = 0;
            while (i < node.keys.length && key >= node.keys[i]) {
                i++;
            }

            const childNode = this._loadNode(node.children[i]);
            const newChild = this._deleteFromNode(childNode, key);

            if (!newChild) {
                return null;
            }

            const newChildren = [...node.children];
            const newChildPointer = this._saveNode(newChild);
            newChildren[i] = newChildPointer;

            return new NodeData(node.id, false, [...node.keys], [], newChildren, null);
        }
    }

    /**
     * Get all entries as array
     */
    toArray() {
        const result = [];
        this._collectAllEntries(this._loadRoot(), result);
        return result;
    }

    /**
     * Async iterator for efficiently traversing all entries without loading everything into memory
     * Enables usage: `for await (const entry of tree) { ... }`
     * Each entry has shape: { key, value }
     */
    async *[Symbol.asyncIterator]() {
        if (!this.isOpen) {
            throw new Error('Tree must be open before iteration');
        }

        if (this._size === 0) {
            return;
        }

        // Use a stack-based traversal instead of relying on next pointers
        // since the persistent/immutable structure makes maintaining leaf links complex
        yield* this._iterateNode(this._loadRoot());
    }

    /**
     * Helper generator to recursively iterate through a node
     * @private
     */
    *_iterateNode(node) {
        if (node.isLeaf) {
            // Yield all entries in this leaf
            for (let i = 0; i < node.keys.length; i++) {
                yield {
                    key: node.keys[i],
                    value: node.values[i]
                };
            }
        } else {
            // Recursively iterate through all children in order
            for (const childPointer of node.children) {
                const child = this._loadNode(childPointer);
                yield* this._iterateNode(child);
            }
        }
    }

    /**
     * Collect all entries in sorted order by traversing tree
     * @private
     */
    _collectAllEntries(node, result) {
        if (node.isLeaf) {
            for (let i = 0; i < node.keys.length; i++) {
                result.push({
                    key: node.keys[i],
                    value: node.values[i]
                });
            }
        } else {
            for (const childPointer of node.children) {
                const child = this._loadNode(childPointer);
                this._collectAllEntries(child, result);
            }
        }
    }

    /**
     * Get tree size
     */
    size() {
        return this._size;
    }

    /**
     * Check if empty
     */
    isEmpty() {
        return this._size === 0;
    }

    /**
     * Range search
     */
    rangeSearch(minKey, maxKey) {
        const result = [];
        this._rangeSearchNode(this._loadRoot(), minKey, maxKey, result);
        return result;
    }

    /**
     * Range search helper that traverses tree
     * @private
     */
    _rangeSearchNode(node, minKey, maxKey, result) {
        if (node.isLeaf) {
            for (let i = 0; i < node.keys.length; i++) {
                if (node.keys[i] >= minKey && node.keys[i] <= maxKey) {
                    result.push({
                        key: node.keys[i],
                        value: node.values[i]
                    });
                }
            }
        } else {
            for (const childPointer of node.children) {
                const child = this._loadNode(childPointer);
                this._rangeSearchNode(child, minKey, maxKey, result);
            }
        }
    }

    /**
     * Get tree height
     */
    getHeight() {
        let height = 0;
        let current = this._loadRoot();

        while (!current.isLeaf) {
            height++;
            current = this._loadNode(current.children[0]);
        }

        return height;
    }

    /**
     * Compact the tree by copying all live entries into a new file.
     * Returns size metrics so callers can see how much space was reclaimed.
     * @param {FileSystemSyncAccessHandle} destSyncHandle - Sync handle for destination file
     * @returns {Promise<{oldSize:number,newSize:number,bytesSaved:number}>}
     */
    async compact(destSyncHandle) {
        if (!this.isOpen) {
            throw new Error('Tree file is not open');
        }
        if (!destSyncHandle) {
            throw new Error('Destination sync handle is required for compaction');
        }

        // Make sure the current file has up-to-date metadata before measuring size
        const oldSize = this.file.getFileSize();

        // Rebuild a fresh tree with only the live entries
        const entries = this.toArray();
        
        const newTree = new BPlusTree(destSyncHandle, this.order);
        await newTree.open();
        for (const entry of entries) {
            await newTree.add(entry.key, entry.value);
        }
        
        // Measure new file size before closing
        const newSize = newTree.file.getFileSize();
        
        await newTree.close();

        return {
            oldSize,
            newSize,
            bytesSaved: Math.max(0, oldSize - newSize)
        };
    }
}
