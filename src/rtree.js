/**
 * On-Disk R-tree implementation using BJsonFile
 * 
 * This implementation stores all data in an append-only binjson file:
 * - Nodes are stored as binjson records
 * - Node references use Pointer objects for file offsets
 * - Updates append new versions rather than modifying in place
 * - An in-memory index tracks the latest offset for each node ID
 * 
 * File format:
 * - Record 0: Metadata (version, maxEntries, size, rootPointer, nextId)
 * - Records 1+: Node data (id, isLeaf, children, bbox)
 *   - For internal nodes: children are Pointer objects to child nodes
 *   - For leaf nodes: children are data entries with {bbox, lat, lng, data}
 */

import { BJsonFile, Pointer, ObjectId, getFileHandle, deleteFile } from './binjson.js';

/**
 * Calculate distance between two points using Haversine formula
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
	const R = 6371; // Earth's radius in kilometers
	const dLat = (lat2 - lat1) * Math.PI / 180;
	const dLng = (lng2 - lng1) * Math.PI / 180;
	const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
		Math.sin(dLng / 2) * Math.sin(dLng / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

/**
 * Convert radius query to bounding box
 */
function radiusToBoundingBox(lat, lng, radiusKm) {
	const latDelta = radiusKm / 111;
	const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
	
	return {
		minLat: lat - latDelta,
		maxLat: lat + latDelta,
		minLng: lng - lngDelta,
		maxLng: lng + lngDelta
	};
}

/**
 * Check if two bounding boxes intersect
 */
function intersects(bbox1, bbox2) {
	return !(bbox1.maxLat < bbox2.minLat ||
		bbox1.minLat > bbox2.maxLat ||
		bbox1.maxLng < bbox2.minLng ||
		bbox1.minLng > bbox2.maxLng);
}

/**
 * Calculate the area of a bounding box
 */
function area(bbox) {
	return (bbox.maxLat - bbox.minLat) * (bbox.maxLng - bbox.minLng);
}

/**
 * Calculate the bounding box that contains both input boxes
 */
function union(bbox1, bbox2) {
	return {
		minLat: Math.min(bbox1.minLat, bbox2.minLat),
		maxLat: Math.max(bbox1.maxLat, bbox2.maxLat),
		minLng: Math.min(bbox1.minLng, bbox2.minLng),
		maxLng: Math.max(bbox1.maxLng, bbox2.maxLng)
	};
}

/**
 * Calculate the enlargement needed to include bbox2 in bbox1
 */
function enlargement(bbox1, bbox2) {
	const unionBox = union(bbox1, bbox2);
	return area(unionBox) - area(bbox1);
}

/**
 * R-tree node stored on disk
 */
class RTreeNode {
	constructor(rtree, nodeData) {
		this.rtree = rtree;
		this.id = nodeData.id;
		this.isLeaf = nodeData.isLeaf;
		this.children = nodeData.children || [];
		this.bbox = nodeData.bbox;
	}

	/**
	 * Update the bounding box to contain all children
	 */
	updateBBox() {
		if (this.children.length === 0) {
			this.bbox = null;
			return;
		}

		let minLat = Infinity, maxLat = -Infinity;
		let minLng = Infinity, maxLng = -Infinity;

		for (const child of this.children) {
			let bbox;
			if (this.isLeaf) {
				// Leaf node: children are data entries
				bbox = child.bbox;
			} else {
				// Internal node: children are Pointers - need to load child nodes
				const childNode = this.rtree._loadNode(child);
				bbox = childNode.bbox;
			}

			if (bbox) {
				minLat = Math.min(minLat, bbox.minLat);
				maxLat = Math.max(maxLat, bbox.maxLat);
				minLng = Math.min(minLng, bbox.minLng);
				maxLng = Math.max(maxLng, bbox.maxLng);
			}
		}

		this.bbox = { minLat, maxLat, minLng, maxLng };
		
		// Save updated node to disk
		this.rtree._saveNode(this);
	}

	/**
	 * Convert node to plain object for serialization
	 */
	toJSON() {
		return {
			id: this.id,
			isLeaf: this.isLeaf,
			children: this.children,
			bbox: this.bbox
		};
	}
}

/**
 * On-disk R-tree implementation
 */
export class RTree {
	constructor(syncHandle, maxEntries = 9) {
		this.file = new BJsonFile(syncHandle);
		this.maxEntries = maxEntries;
		this.minEntries = Math.max(2, Math.ceil(maxEntries / 2));
		
		// Metadata
		this.rootPointer = null;
		this.nextId = 1;
		this._size = 0;
		
		this.isOpen = false;
	}

	/**
	 * Open the R-tree (load or initialize metadata)
	 */
	async open() {
		if (this.isOpen) {
			throw new Error('R-tree is already open');
		}

		const fileSize = this.file.getFileSize();
		const exists = fileSize > 0;

		if (exists) {
			// Load existing tree
			this._loadFromFile();
		} else {
			// Create new tree
			this._initializeNewTree();
		}
		
		this.isOpen = true;
	}

	/**
	 * Close the R-tree
	 */
	async close() {
		if (this.isOpen) {
			this._writeMetadata();
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
		// Create root node
		const rootNode = new RTreeNode(this, {
			id: 0,
			isLeaf: true,
			children: [],
			bbox: null
		});
		
		this.nextId = 1;
		this._size = 0;
		
		// Save root node
		this.rootPointer = this._saveNode(rootNode);
		
		// Write metadata as first record
		this._writeMetadata();
	}

	/**
	 * Write metadata record to file
	 */
	_writeMetadata() {
		const metadata = {
			version: 1,
			maxEntries: this.maxEntries,
			minEntries: this.minEntries,
			size: this._size,
			rootPointer: this.rootPointer,
			nextId: this.nextId
		};
		
		// Append metadata to file (don't use write which truncates)
		this.file.append(metadata);
	}

	/**
	 * Load tree from existing file
	 */
	_loadFromFile() {
		// Calculate fixed metadata size:
		// Metadata object has 6 fields: version, maxEntries, minEntries, size, rootPointer, nextId
		// All are INT type encoded as 8-byte ints (1 type byte + 8 bytes payload)
		// Object encoding: TYPE (1) + SIZE (4) + COUNT (4) + key-value pairs
		// Total size with 8-byte ints: 135 bytes
		const METADATA_SIZE = 135;
		
		const fileSize = this.file.getFileSize();
		if (fileSize < METADATA_SIZE) {
			throw new Error('Invalid R-tree file format: file too small for metadata');
		}
		
		// Read metadata from the end of the file
		const metadataOffset = fileSize - METADATA_SIZE;
		const metadata = this.file.read(metadataOffset);
		
		this.maxEntries = metadata.maxEntries;
		this.minEntries = metadata.minEntries;
		this._size = metadata.size;
		this.rootPointer = metadata.rootPointer;
		this.nextId = metadata.nextId;
	}

	/**
	 * Save a node to disk and return its Pointer
	 */
	_saveNode(node) {
		const nodeData = node.toJSON();
		
		// Get current file size (this is where the node will be stored)
		const offset = this.file.getFileSize();
		
		// Append node to file
		this.file.append(nodeData);
		
		// Return pointer to the saved node
		return new Pointer(offset);
	}

	/**
	 * Load a node from disk by Pointer
	 */
	_loadNode(pointer) {
		if (!(pointer instanceof Pointer)) {
			throw new Error('Expected Pointer object');
		}
		
		const offset = pointer.valueOf();
		
		// Read the node from file at this offset
		const nodeData = this.file.read(offset);
		
		return new RTreeNode(this, nodeData);
	}

	/**
	 * Load the root node
	 */
	_loadRoot() {
		return this._loadNode(this.rootPointer);
	}

	/**
	 * Insert a point into the R-tree with an ObjectId
	 */
	insert(lat, lng, objectId) {
		if (!this.isOpen) {
			throw new Error('R-tree file must be opened before use');
		}

    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to insert into rtree');
    }

		const bbox = {
			minLat: lat,
			maxLat: lat,
			minLng: lng,
			maxLng: lng
		};

		const entry = { bbox, lat, lng, objectId };
		
		const root = this._loadRoot();
		const result = this._insert(entry, root, 1);
		
		if (result.split) {
			// Root was split, create new root
			const newRoot = new RTreeNode(this, {
				id: this.nextId++,
				isLeaf: false,
				children: result.pointers,
				bbox: null
			});
			
			newRoot.updateBBox();
			this.rootPointer = this._saveNode(newRoot);
		} else {
			// Root was updated but not split, update the pointer
			this.rootPointer = result.pointer;
		}
		
		this._size++;
		this._writeMetadata();
	}

	/**
	 * Internal insert method - returns splitPointers if split occurred, else returns updated node pointer
	 */
	_insert(entry, node, level) {
		if (node.isLeaf) {
			node.children.push(entry);
			node.updateBBox();

			if (node.children.length > this.maxEntries) {
				const [pointer1, pointer2] = this._split(node);
				return { split: true, pointers: [pointer1, pointer2] };
			}
			
			// Save updated leaf node
			const pointer = this._saveNode(node);
			return { split: false, pointer };
		} else {
			// Choose subtree
			const targetPointer = this._chooseSubtree(entry.bbox, node);
			const targetNode = this._loadNode(targetPointer);
			const result = this._insert(entry, targetNode, level + 1);

			if (result.split) {
				// Child was split, find and replace it
				let childIndex = -1;
				for (let i = 0; i < node.children.length; i++) {
					if (node.children[i].valueOf() === targetPointer.valueOf()) {
						childIndex = i;
						break;
					}
				}
				
				if (childIndex !== -1) {
					// Replace the old child with both new children
					node.children[childIndex] = result.pointers[0];
					node.children.push(result.pointers[1]);
				} else {
					// Shouldn't happen, but add both if we can't find
					node.children.push(result.pointers[0]);
					node.children.push(result.pointers[1]);
				}
				node.updateBBox();

				if (node.children.length > this.maxEntries) {
					const [pointer1, pointer2] = this._split(node);
					return { split: true, pointers: [pointer1, pointer2] };
				}
			} else {
				// Child was not split, but may have been updated with new pointer
				// Update the child pointer in this node's children
				let childIndex = -1;
				for (let i = 0; i < node.children.length; i++) {
					if (node.children[i].valueOf() === targetPointer.valueOf()) {
						childIndex = i;
						break;
					}
				}
				
				if (childIndex !== -1) {
					// Update child pointer to point to the new version
					node.children[childIndex] = result.pointer;
				}
				
				// Update this node's bbox (use the current children pointers)
				node.updateBBox();
			}
			
		// Save updated internal node
		const pointer = this._saveNode(node);
		return { split: false, pointer };
    }
	}

	/**
	 * Choose the best subtree to insert an entry
	 */
	_chooseSubtree(bbox, node) {
		let minEnlargement = Infinity;
		let minArea = Infinity;
		let targetPointer = null;

    for (const childPointer of node.children) {
			// Debug: check if we have a Pointer
			if (!(childPointer instanceof Pointer)) {
				throw new Error(`Expected Pointer in _chooseSubtree, got: ${typeof childPointer}`);
			}
			
			const childNode = this._loadNode(childPointer);
			const enl = enlargement(childNode.bbox, bbox);
			const ar = area(childNode.bbox);

			if (enl < minEnlargement || (enl === minEnlargement && ar < minArea)) {
				minEnlargement = enl;
				minArea = ar;
				targetPointer = childPointer;
			}
		}

		return targetPointer;
	}

	/**
	 * Split an overflowing node
	 */
	_split(node) {
		const children = node.children;
		const isLeaf = node.isLeaf;

		// Find two seeds (most distant entries)
		let maxDist = -Infinity;
		let seed1Idx = 0, seed2Idx = 1;

		for (let i = 0; i < children.length; i++) {
			for (let j = i + 1; j < children.length; j++) {
				let bbox1, bbox2;
				
				if (isLeaf) {
					bbox1 = children[i].bbox;
					bbox2 = children[j].bbox;
				} else {
					const node1 = this._loadNode(children[i]);
					const node2 = this._loadNode(children[j]);
					bbox1 = node1.bbox;
					bbox2 = node2.bbox;
				}
				
				const dist = area(union(bbox1, bbox2));
				if (dist > maxDist) {
					maxDist = dist;
					seed1Idx = i;
					seed2Idx = j;
				}
			}
		}

		// Create two new nodes
		const node1 = new RTreeNode(this, {
			id: this.nextId++,
			isLeaf: isLeaf,
			children: [children[seed1Idx]],
			bbox: null
		});

		const node2 = new RTreeNode(this, {
			id: this.nextId++,
			isLeaf: isLeaf,
			children: [children[seed2Idx]],
			bbox: null
		});

		// Distribute remaining entries
		for (let i = 0; i < children.length; i++) {
			if (i === seed1Idx || i === seed2Idx) continue;

			const child = children[i];
			
			let bbox;
			if (isLeaf) {
				bbox = child.bbox;
			} else {
				const childNode = this._loadNode(child);
				bbox = childNode.bbox;
			}
			
			node1.updateBBox();
			node2.updateBBox();
			
			const enl1 = node1.bbox ? enlargement(node1.bbox, bbox) : 0;
			const enl2 = node2.bbox ? enlargement(node2.bbox, bbox) : 0;

			if (enl1 < enl2) {
				node1.children.push(child);
			} else if (enl2 < enl1) {
				node2.children.push(child);
			} else {
				// Equal enlargement, choose one with fewer children
				if (node1.children.length <= node2.children.length) {
					node1.children.push(child);
				} else {
					node2.children.push(child);
				}
			}
		}

		node1.updateBBox();
		node2.updateBBox();

		// Save both nodes (don't reuse the original node)
		const pointer1 = this._saveNode(node1);
		const pointer2 = this._saveNode(node2);

		// Return both pointers
		return [pointer1, pointer2];
	}

	/**
	 * Search for points within a bounding box, returning entries with coords
	 */
	searchBBox(bbox) {
		if (!this.isOpen) {
			throw new Error('R-tree file must be opened before use');
		}

		const results = [];
		const root = this._loadRoot();
		this._searchBBox(bbox, root, results);
		return results;
	}

	/**
	 * Internal bounding box search
	 */
	_searchBBox(bbox, node, results) {
		if (!node.bbox || !intersects(bbox, node.bbox)) {
			return;
		}

		if (node.isLeaf) {
			for (const entry of node.children) {
				if (intersects(bbox, entry.bbox)) {
					results.push({
						objectId: entry.objectId,
						lat: entry.lat,
						lng: entry.lng
					});
				}
			}
		} else {
			for (const childPointer of node.children) {
				const childNode = this._loadNode(childPointer);
				this._searchBBox(bbox, childNode, results);
			}
		}
	}

	/**
	 * Search for points within a radius of a location, returning ObjectIds with distances
	 */
	searchRadius(lat, lng, radiusKm) {
		const bbox = radiusToBoundingBox(lat, lng, radiusKm);
		const root = this._loadRoot();
		const entries = [];
		this._searchBBoxEntries(bbox, root, entries);

		const results = [];
		for (const entry of entries) {
			const dist = haversineDistance(lat, lng, entry.lat, entry.lng);
			if (dist <= radiusKm) {
				results.push({
					objectId: entry.objectId,
					lat: entry.lat,
					lng: entry.lng,
					distance: dist
				});
			}
		}

		return results;
	}

	/**
	 * Internal bounding box search that returns full entries (used by radius search)
	 */
	_searchBBoxEntries(bbox, node, results) {
		if (!node.bbox || !intersects(bbox, node.bbox)) {
			return;
		}

		if (node.isLeaf) {
			for (const entry of node.children) {
				if (intersects(bbox, entry.bbox)) {
					results.push(entry);
				}
			}
		} else {
			for (const childPointer of node.children) {
				const childNode = this._loadNode(childPointer);
				this._searchBBoxEntries(bbox, childNode, results);
			}
		}
	}

	/**
	 * Remove an entry from the R-tree by ObjectId
	 */
	remove(objectId) {
		if (!this.isOpen) {
			throw new Error('R-tree file must be opened before use');
		}

    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to remove from rtree');
    }

		const root = this._loadRoot();
		const result = this._remove(objectId, root);

		if (!result.found) {
			return false; // Entry not found
		}

		if (result.underflow && result.children) {
			// Root underflowed and has children
			if (result.children.length === 0) {
				// Tree is now empty, create new empty root
				const newRoot = new RTreeNode(this, {
					id: this.nextId++,
					isLeaf: true,
					children: [],
					bbox: null
				});
				this.rootPointer = this._saveNode(newRoot);
			} else if (result.children.length === 1 && !result.isLeaf) {
				// Root has only one child and is internal node - make child the new root
				this.rootPointer = result.children[0];
			} else {
				// Root underflowed but still has multiple children, save it
				const newRoot = new RTreeNode(this, {
					id: root.id,
					isLeaf: result.isLeaf,
					children: result.children,
					bbox: null
				});
				newRoot.updateBBox();
				this.rootPointer = this._saveNode(newRoot);
			}
		} else if (result.pointer) {
			// Root was updated
			this.rootPointer = result.pointer;
		}

		this._size--;
		this._writeMetadata();
		return true;
	}

	/**
	 * Internal remove method
	 * Returns: { found: boolean, underflow: boolean, pointer: Pointer, children: Array, isLeaf: boolean }
	 */
	_remove(objectId, node) {
		if (node.isLeaf) {
			// Find and remove the entry
			const initialLength = node.children.length;
			node.children = node.children.filter(entry => 
				!entry.objectId.equals(objectId)
			);

			if (node.children.length === initialLength) {
				// Entry not found
				return { found: false };
			}

			node.updateBBox();
			const pointer = this._saveNode(node);

			// Check for underflow
			const underflow = node.children.length < this.minEntries && node.children.length > 0;
			
			return {
				found: true,
				underflow,
				pointer,
				children: node.children,
				isLeaf: true
			};
		} else {
			// Internal node - search children
			let found = false;
			let updatedChildren = [...node.children];

			for (let i = 0; i < updatedChildren.length; i++) {
				const childPointer = updatedChildren[i];
				const childNode = this._loadNode(childPointer);

				// Check if the child's bbox could contain the entry
				// For internal nodes, we need to check all children since we don't store exact coordinates
				const result = this._remove(objectId, childNode);

				if (result.found) {
					found = true;

					if (result.underflow) {
						// Child underflowed, try to handle it
						const handled = this._handleUnderflow(node, i, childNode, result);
						
						if (handled.merged) {
							// Node was merged or redistributed, update children array
							updatedChildren = handled.children;
						} else {
							// Just update the pointer
							updatedChildren[i] = result.pointer;
						}
					} else {
						// Update child pointer
						updatedChildren[i] = result.pointer;
					}

					// Update this node
					const updatedNode = new RTreeNode(this, {
						id: node.id,
						isLeaf: false,
						children: updatedChildren,
						bbox: null
					});
					updatedNode.updateBBox();
					const pointer = this._saveNode(updatedNode);

					// Check if this node now underflows
					const underflow = updatedChildren.length < this.minEntries && updatedChildren.length > 0;

					return {
						found: true,
						underflow,
						pointer,
						children: updatedChildren,
						isLeaf: false
					};
				}
			}

			// Entry not found in any child
			return { found: false };
		}
	}

	/**
	 * Handle underflow in a child node by merging or redistributing
	 */
	_handleUnderflow(parentNode, childIndex, childNode, childResult) {
		const siblings = [];

		// Find siblings (nodes before and after)
		if (childIndex > 0) {
			const prevPointer = parentNode.children[childIndex - 1];
			const prevNode = this._loadNode(prevPointer);
			siblings.push({ index: childIndex - 1, node: prevNode, pointer: prevPointer });
		}
		if (childIndex < parentNode.children.length - 1) {
			const nextPointer = parentNode.children[childIndex + 1];
			const nextNode = this._loadNode(nextPointer);
			siblings.push({ index: childIndex + 1, node: nextNode, pointer: nextPointer });
		}

		// Try to borrow from a sibling
		for (const sibling of siblings) {
			if (sibling.node.children.length > this.minEntries) {
				// Sibling has extra entries, redistribute
				const allChildren = [
					...childResult.children,
					...sibling.node.children
				];

				const mid = Math.ceil(allChildren.length / 2);
				const newChild1Children = allChildren.slice(0, mid);
				const newChild2Children = allChildren.slice(mid);

				const newChild1 = new RTreeNode(this, {
					id: childNode.id,
					isLeaf: childResult.isLeaf,
					children: newChild1Children,
					bbox: null
				});
				newChild1.updateBBox();

				const newChild2 = new RTreeNode(this, {
					id: sibling.node.id,
					isLeaf: sibling.node.isLeaf,
					children: newChild2Children,
					bbox: null
				});
				newChild2.updateBBox();

				const pointer1 = this._saveNode(newChild1);
				const pointer2 = this._saveNode(newChild2);

				// Update parent's children
				const newChildren = [...parentNode.children];
				const minIndex = Math.min(childIndex, sibling.index);
				const maxIndex = Math.max(childIndex, sibling.index);
				
				newChildren[minIndex] = pointer1;
				newChildren[maxIndex] = pointer2;

				return { merged: true, children: newChildren };
			}
		}

		// Can't borrow, merge with a sibling
		if (siblings.length > 0) {
			const sibling = siblings[0];
			const mergedChildren = [
				...childResult.children,
				...sibling.node.children
			];

			const mergedNode = new RTreeNode(this, {
				id: this.nextId++,
				isLeaf: childResult.isLeaf,
				children: mergedChildren,
				bbox: null
			});
			mergedNode.updateBBox();
			const mergedPointer = this._saveNode(mergedNode);

			// Update parent's children - remove both old nodes, add merged
			const newChildren = parentNode.children.filter((_, i) => 
				i !== childIndex && i !== sibling.index
			);
			newChildren.push(mergedPointer);

			return { merged: true, children: newChildren };
		}

		// No siblings (shouldn't happen except for root)
		return { merged: false };
	}

	/**
	 * Get the number of entries in the tree
	 */
	size() {
		return this._size;
	}

	/**
	 * Clear all entries from the tree by appending a new empty root node
	 * Preserves the append-only file structure
	 */
	async clear() {
		// Create a new empty root node and append it to the file
		const newRoot = new RTreeNode(this, {
			id: this.nextId++,
			isLeaf: true,
			children: [],
			bbox: null
		});
		
		this.rootPointer = this._saveNode(newRoot);
		this._size = 0;
		this._writeMetadata();
	}

	/**
	 * Compact the R-tree by copying the current root and all reachable nodes into a new file.
	 * Returns size metrics to show reclaimed space.
	 * @param {FileSystemSyncAccessHandle} destSyncHandle - Sync handle for destination file
	 */
	async compact(destSyncHandle) {
		if (!this.isOpen) {
			throw new Error('R-tree file must be opened before use');
		}
		if (!destSyncHandle) {
			throw new Error('Destination sync handle is required for compaction');
		}

		// Flush current metadata so size reflects latest state
		this._writeMetadata();
		const oldSize = this.file.getFileSize();

		const dest = new RTree(destSyncHandle, this.maxEntries);
		await dest.open();
		
		// After opening, set the properties we want to preserve
		dest.minEntries = this.minEntries;
		dest.nextId = this.nextId;
		dest._size = this._size;

		const pointerMap = new Map();

		const cloneNode = (pointer) => {
			const offset = pointer.valueOf();
			if (pointerMap.has(offset)) {
				return pointerMap.get(offset);
			}

			const sourceNode = this._loadNode(pointer);
			const clonedChildren = [];

			if (sourceNode.isLeaf) {
				// Leaf children are plain entries
				for (const child of sourceNode.children) {
					clonedChildren.push(child);
				}
			} else {
				for (const childPointer of sourceNode.children) {
					const newChildPtr = cloneNode(childPointer);
					clonedChildren.push(newChildPtr);
				}
			}

			const clonedNode = new RTreeNode(dest, {
				id: sourceNode.id,
				isLeaf: sourceNode.isLeaf,
				children: clonedChildren,
				bbox: sourceNode.bbox
			});

			const newPointer = dest._saveNode(clonedNode);
			pointerMap.set(offset, newPointer);
			return newPointer;
		};

		const newRootPointer = cloneNode(this.rootPointer);
		dest.rootPointer = newRootPointer;

		dest._writeMetadata();
		
		// Get size of destination file BEFORE closing
		const newSize = dest.file.getFileSize();
		
		await dest.close();

		return {
			oldSize,
			newSize,
			bytesSaved: Math.max(0, oldSize - newSize)
		};
	}
}

export default RTree;
