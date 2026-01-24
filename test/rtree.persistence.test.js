/**
 * Persistence tests for RTree
 * Tests that spatial data survives close/reopen cycles
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { RTree } from '../src/rtree.js';
import { ObjectId, deleteFile, getFileHandle } from '../src/binjson.js';

// Set up node-opfs for Node.js environment
let hasOPFS = false;
let rootDirHandle = null;

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

// Initialize OPFS root directory handle if available
if (hasOPFS) {
  beforeAll(async () => {
    if (navigator.storage && navigator.storage.getDirectory) {
      rootDirHandle = await navigator.storage.getDirectory();
    }
  });
}

let testFileCounter = 0;

function getTestFilename() {
  return `test-rtree-persistence-${Date.now()}-${testFileCounter++}.bj`;
}

async function createTestTree(order = 4) {
  const filename = getTestFilename();
  const fileHandle = await getFileHandle(rootDirHandle, filename, { create: true });
  const syncHandle = await fileHandle.createSyncAccessHandle();
  const tree = new RTree(syncHandle, order);
  tree._testFilename = filename;
  return tree;
}

async function reopenTree(filename, order = 4) {
  const fileHandle = await getFileHandle(rootDirHandle, filename, { create: false });
  const syncHandle = await fileHandle.createSyncAccessHandle();
  const tree = new RTree(syncHandle, order);
  tree._testFilename = filename;
  return tree;
}

async function cleanupFile(filename) {
    if (rootDirHandle) {
      await deleteFile(rootDirHandle, filename);
    }
}

describe.skipIf(!hasOPFS)('RTree Persistence', () => {

  afterEach(async () => {
    // Cleanup happens within each test
  });

  it('should persist and reload a single point', async () => {
    const id = new ObjectId();

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, id);
    expect(tree.size()).toBe(1);
    
    await tree.close();

    // Reopen and verify
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(1);
    
    const bbox = {
      minLat: 40,
      maxLat: 41,
      minLng: -75,
      maxLng: -74
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(1);
    expect(results[0].objectId).toEqual(id);
    expect(results[0].lat).toBeCloseTo(40.7128);
    expect(results[0].lng).toBeCloseTo(-74.0060);
    
    await tree.close();
  });

  it('should persist and reload multiple points', async () => {
    const points = [
      { id: new ObjectId(), lat: 40.7128, lng: -74.0060, name: 'New York' },
      { id: new ObjectId(), lat: 34.0522, lng: -118.2437, name: 'Los Angeles' },
      { id: new ObjectId(), lat: 41.8781, lng: -87.6298, name: 'Chicago' },
      { id: new ObjectId(), lat: 29.7604, lng: -95.3698, name: 'Houston' },
      { id: new ObjectId(), lat: 39.7392, lng: -104.9903, name: 'Denver' }
    ];

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    for (const point of points) {
      tree.insert(point.lat, point.lng, point.id);
    }
    expect(tree.size()).toBe(points.length);
    
    await tree.close();

    // Reopen and verify all points
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(points.length);
    
    // Search entire US bounding box
    const bbox = {
      minLat: 25,
      maxLat: 50,
      minLng: -125,
      maxLng: -66
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(points.length);
    
    // Verify each point can be found
    for (const point of points) {
      const pointBbox = {
        minLat: point.lat - 1,
        maxLat: point.lat + 1,
        minLng: point.lng - 1,
        maxLng: point.lng + 1
      };
      const found = tree.searchBBox(pointBbox);
      expect(found.some(p => p.objectId.equals(point.id))).toBe(true);
    }
    
    await tree.close();
  });

  it('should persist bounding box queries across close/reopen', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const id3 = new ObjectId();

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, id1); // NYC
    tree.insert(34.0522, -118.2437, id2); // LA
    tree.insert(41.8781, -87.6298, id3); // Chicago
    
    await tree.close();

    // Reopen and verify bounding box queries
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    // Query for northeastern US
    const bbox = {
      minLat: 40,
      maxLat: 42,
      minLng: -75,
      maxLng: -73
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(1);
    expect(results[0].objectId).toEqual(id1);
    
    await tree.close();
  });

  it('should persist radius searches across close/reopen', async () => {
    const idNY = new ObjectId();
    const idNJ = new ObjectId();
    const idPA = new ObjectId();

    // Create and populate tree with points near NYC
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, idNY);  // NYC
    tree.insert(40.7282, -74.1502, idNJ); // Jersey City (~10km)
    tree.insert(40.2206, -74.7597, idPA); // Princeton (~50km)
    
    await tree.close();

    // Reopen and verify radius search
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(3);
    
    // Search within 25km of NYC
    const results = tree.searchRadius(40.7128, -74.0060, 25);
    expect(results.length).toBeGreaterThanOrEqual(2); // NYC + Jersey City
    
    await tree.close();
  });

  it('should persist and reload large dataset', async () => {
    const count = 50;
    const ids = [];
    const points = [];

    // Create test data
    for (let i = 0; i < count; i++) {
      const id = new ObjectId();
      ids.push(id);
      points.push({
        id,
        lat: 25 + Math.random() * 24,
        lng: -125 + Math.random() * 59
      });
    }

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    for (const point of points) {
      tree.insert(point.lat, point.lng, point.id);
    }
    expect(tree.size()).toBe(count);
    
    await tree.close();

    // Reopen and verify
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(count);
    
    // Search entire US bounding box
    const bbox = {
      minLat: 25,
      maxLat: 49,
      minLng: -125,
      maxLng: -66
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(count);
    
    await tree.close();
  });

  it('should persist and reload with multiple close/reopen cycles', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const id3 = new ObjectId();
    const id4 = new ObjectId();

    // First cycle: add initial points
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, id1); // NYC
    tree.insert(34.0522, -118.2437, id2); // LA
    
    await tree.close();

    // Second cycle: verify and add more points
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(2);
    
    const bbox1 = {
      minLat: 40,
      maxLat: 41,
      minLng: -75,
      maxLng: -73
    };
    let results = tree.searchBBox(bbox1);
    expect(results).toHaveLength(1);
    
    tree.insert(41.8781, -87.6298, id3); // Chicago
    tree.insert(39.7392, -104.9903, id4); // Denver
    
    await tree.close();

    // Third cycle: verify all points
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(4);
    
    const bbox2 = {
      minLat: 25,
      maxLat: 50,
      minLng: -125,
      maxLng: -66
    };
    results = tree.searchBBox(bbox2);
    expect(results).toHaveLength(4);
    
    await tree.close();
  });

  it('should persist after deletions', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const id3 = new ObjectId();

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, id1);
    tree.insert(34.0522, -118.2437, id2);
    tree.insert(41.8781, -87.6298, id3);
    
    expect(tree.size()).toBe(3);
    
    // Delete one point
    tree.remove(id2);
    expect(tree.size()).toBe(2);
    
    await tree.close();

    // Reopen and verify deletion persisted
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(2);
    
    // Verify LA (id2) is not found
    const bbox = {
      minLat: 30,
      maxLat: 36,
      minLng: -122,
      maxLng: -116
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(0);
    
    // Verify other points are still there
    const bbox2 = {
      minLat: 25,
      maxLat: 50,
      minLng: -125,
      maxLng: -66
    };
    const allResults = tree.searchBBox(bbox2);
    expect(allResults).toHaveLength(2);
    
    await tree.close();
  });

  it('should persist tree structure with custom maxEntries', async () => {
    const maxEntries = 6;
    const count = 30;
    const ids = [];

    // Create test data
    for (let i = 0; i < count; i++) {
      ids.push(new ObjectId());
    }

    // Create and populate tree with custom maxEntries
    let tree = await createTestTree(maxEntries);
    await tree.open();
    const filename = tree._testFilename;
    
    for (let i = 0; i < count; i++) {
      const lat = 25 + Math.random() * 24;
      const lng = -125 + Math.random() * 59;
      tree.insert(lat, lng, ids[i]);
    }
    
    expect(tree.size()).toBe(count);
    
    await tree.close();

    // Reopen and verify tree maintains structure
    tree = await reopenTree(filename, maxEntries);
    await tree.open();
    
    expect(tree.maxEntries).toBe(maxEntries);
    expect(tree.size()).toBe(count);
    
    // Verify spatial queries still work
    const bbox = {
      minLat: 25,
      maxLat: 49,
      minLng: -125,
      maxLng: -66
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(count);
    
    await tree.close();
  });

  it('should persist empty tree after removing all points', async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    tree.insert(40.7128, -74.0060, id1);
    tree.insert(34.0522, -118.2437, id2);
    
    // Remove all points
    tree.remove(id1);
    tree.remove(id2);
    
    expect(tree.size()).toBe(0);
    
    await tree.close();

    // Reopen and verify empty
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(0);
    
    const bbox = {
      minLat: 25,
      maxLat: 50,
      minLng: -125,
      maxLng: -66
    };
    const results = tree.searchBBox(bbox);
    expect(results).toHaveLength(0);
    
    await tree.close();
  });

  it('should correctly retrieve points after reload with overlapping bboxes', async () => {
    const midwestPoints = [
      { id: new ObjectId(), lat: 41.8781, lng: -87.6298 }, // Chicago
      { id: new ObjectId(), lat: 39.7392, lng: -104.9903 }, // Denver
      { id: new ObjectId(), lat: 35.0896, lng: -106.6055 }  // Albuquerque
    ];

    // Create and populate tree
    let tree = await createTestTree(4);
    const filename = tree._testFilename;
    await tree.open();
    
    for (const point of midwestPoints) {
      tree.insert(point.lat, point.lng, point.id);
    }
    
    await tree.close();

    // Reopen and test overlapping queries
    tree = await reopenTree(filename, 4);
    await tree.open();
    
    expect(tree.size()).toBe(3);
    
    // Large bbox containing all
    const largeBbox = {
      minLat: 30,
      maxLat: 45,
      minLng: -110,
      maxLng: -85
    };
    let results = tree.searchBBox(largeBbox);
    expect(results).toHaveLength(3);
    
    // Smaller bbox containing subset
    const smallBbox = {
      minLat: 38,
      maxLat: 42,
      minLng: -90,
      maxLng: -85
    };
    results = tree.searchBBox(smallBbox);
    expect(results).toHaveLength(1); // Only Chicago
    expect(results[0].objectId).toEqual(midwestPoints[0].id);
    
    await tree.close();
  });
});
