/**
 * Performance benchmark comparing BPlusTree (value objects in nodes) 
 * vs BPlusTreePtr (pointers to values)
 * 
 * Tests various scenarios:
 * 1. Small values (simple strings/numbers)
 * 2. Large values (complex objects with lots of data)
 * 3. Sequential inserts
 * 4. Random inserts
 * 5. Mixed operations (inserts, searches, deletes)
 */

import { BPlusTree } from '../src/bplustree.js';
import { BPlusTreePtr } from '../src/bplustree-ptr.js';
import { getFileHandle, deleteFile } from '../src/binjson.js';

// Setup node-opfs for Node.js
try {
    const nodeOpfs = await import('node-opfs');
    if (nodeOpfs.navigator && typeof global !== 'undefined') {
        Object.defineProperty(global, 'navigator', {
            value: nodeOpfs.navigator,
            writable: true,
            configurable: true
        });
    }
} catch (e) {
    console.error('Failed to setup node-opfs:', e.message);
    process.exit(1);
}

const rootDirHandle = await navigator.storage.getDirectory();

/**
 * Create a test tree
 */
async function createTree(TreeClass, filename, order = 4) {
    const fileHandle = await getFileHandle(rootDirHandle, filename, { create: true });
    const syncHandle = await fileHandle.createSyncAccessHandle();
    const tree = new TreeClass(syncHandle, order);
    tree._testFilename = filename;
    await tree.open();
    return tree;
}

/**
 * Cleanup test file
 */
async function cleanup(tree) {
    if (tree.isOpen) {
        await tree.close();
    }
    if (tree._testFilename) {
        await deleteFile(rootDirHandle, tree._testFilename);
    }
}

/**
 * Generate a small value (simple string)
 */
function generateSmallValue(key) {
    return `value_${key}`;
}

/**
 * Generate a large value (complex object with nested data)
 */
function generateLargeValue(key) {
    return {
        id: key,
        name: `User ${key}`,
        email: `user${key}@example.com`,
        address: {
            street: `${key} Main Street`,
            city: 'Springfield',
            state: 'IL',
            zip: '62701',
            country: 'USA'
        },
        profile: {
            bio: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10),
            interests: ['reading', 'coding', 'hiking', 'photography', 'music'],
            skills: Array(20).fill(0).map((_, i) => `Skill ${i + 1}`),
            experience: Array(5).fill(0).map((_, i) => ({
                company: `Company ${i + 1}`,
                role: `Role ${i + 1}`,
                years: i + 1,
                description: 'Lorem ipsum dolor sit amet. '.repeat(5)
            }))
        },
        metadata: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            version: 1,
            tags: Array(10).fill(0).map((_, i) => `tag${i}`)
        }
    };
}

/**
 * Run a benchmark test
 */
async function runBenchmark(name, TreeClass, operations, valueGenerator, order = 4) {
    const filename = `bench-${Date.now()}-${Math.random()}.bj`;
    let tree;
    
    try {
        tree = await createTree(TreeClass, filename, order);
        
        const startTime = performance.now();
        await operations(tree, valueGenerator);
        const endTime = performance.now();
        
        const duration = endTime - startTime;
        const fileSize = tree.file.getFileSize();
        
        await cleanup(tree);
        
        return { duration, fileSize };
    } catch (error) {
        if (tree) {
            await cleanup(tree);
        }
        throw error;
    }
}

/**
 * Sequential insert operations
 */
async function sequentialInserts(tree, valueGenerator, count = 1000) {
    for (let i = 0; i < count; i++) {
        await tree.add(i, valueGenerator(i));
    }
}

/**
 * Random insert operations
 */
async function randomInserts(tree, valueGenerator, count = 1000) {
    const keys = Array.from({ length: count }, (_, i) => i);
    // Shuffle keys
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    
    for (const key of keys) {
        await tree.add(key, valueGenerator(key));
    }
}

/**
 * Mixed operations (inserts, searches, updates)
 */
async function mixedOperations(tree, valueGenerator, count = 500) {
    // Insert initial data
    for (let i = 0; i < count; i++) {
        await tree.add(i, valueGenerator(i));
    }
    
    // Perform mixed operations
    for (let i = 0; i < count / 2; i++) {
        const key = Math.floor(Math.random() * count);
        
        // Search
        await tree.search(key);
        
        // Update (insert with existing key)
        await tree.add(key, valueGenerator(key + 1000));
        
        // Another search
        await tree.search(key);
    }
}

/**
 * Search-heavy workload
 */
async function searchHeavy(tree, valueGenerator, count = 500) {
    // Insert data
    for (let i = 0; i < count; i++) {
        await tree.add(i, valueGenerator(i));
    }
    
    // Perform many searches
    for (let i = 0; i < count * 5; i++) {
        const key = Math.floor(Math.random() * count);
        await tree.search(key);
    }
}

/**
 * Range search operations
 */
async function rangeSearchOps(tree, valueGenerator, count = 500) {
    // Insert data
    for (let i = 0; i < count; i++) {
        await tree.add(i, valueGenerator(i));
    }
    
    // Perform range searches
    for (let i = 0; i < 100; i++) {
        const start = Math.floor(Math.random() * (count - 50));
        const end = start + 50;
        await tree.rangeSearch(start, end);
    }
}

/**
 * Format results table
 */
function formatResults(results) {
    console.log('\n' + '='.repeat(100));
    console.log('PERFORMANCE COMPARISON RESULTS');
    console.log('='.repeat(100));
    
    for (const category of Object.keys(results)) {
        console.log(`\n${category.toUpperCase()}:`);
        console.log('-'.repeat(100));
        
        for (const test of Object.keys(results[category])) {
            const orig = results[category][test].original;
            const ptr = results[category][test].pointer;
            
            const speedup = ((orig.duration - ptr.duration) / orig.duration * 100).toFixed(1);
            const sizeRatio = (ptr.fileSize / orig.fileSize * 100).toFixed(1);
            
            console.log(`\n${test}:`);
            console.log(`  Original: ${orig.duration.toFixed(2)}ms, ${(orig.fileSize / 1024).toFixed(2)}KB`);
            console.log(`  Pointer:  ${ptr.duration.toFixed(2)}ms, ${(ptr.fileSize / 1024).toFixed(2)}KB`);
            console.log(`  Speedup:  ${speedup > 0 ? '+' : ''}${speedup}% faster`);
            console.log(`  Size:     ${sizeRatio}% of original`);
        }
    }
    
    console.log('\n' + '='.repeat(100));
}

/**
 * Main benchmark runner
 */
async function main() {
    console.log('Starting B+ Tree Performance Benchmark...\n');
    console.log('Comparing:');
    console.log('  - BPlusTree (original): Values stored directly in tree nodes');
    console.log('  - BPlusTreePtr (pointer-based): Values stored separately, pointers in nodes');
    console.log('\nThis may take a few minutes...\n');
    
    const results = {
        'Small Values (strings)': {},
        'Large Values (complex objects)': {}
    };
    
    const tests = [
        { name: 'Sequential Inserts (1000)', fn: (t, v) => sequentialInserts(t, v, 1000) },
        { name: 'Random Inserts (1000)', fn: (t, v) => randomInserts(t, v, 1000) },
        { name: 'Mixed Operations (500 insert + searches)', fn: (t, v) => mixedOperations(t, v, 500) },
        { name: 'Search Heavy (500 insert + 2500 searches)', fn: (t, v) => searchHeavy(t, v, 500) },
        { name: 'Range Searches (500 insert + 100 range queries)', fn: (t, v) => rangeSearchOps(t, v, 500) }
    ];
    
    // Test with small values
    console.log('Testing with SMALL VALUES (simple strings)...');
    for (const test of tests) {
        console.log(`  Running: ${test.name}`);
        const origResult = await runBenchmark(`${test.name} - Original`, BPlusTree, test.fn, generateSmallValue);
        const ptrResult = await runBenchmark(`${test.name} - Pointer`, BPlusTreePtr, test.fn, generateSmallValue);
        
        results['Small Values (strings)'][test.name] = {
            original: origResult,
            pointer: ptrResult
        };
    }
    
    // Test with large values
    console.log('\nTesting with LARGE VALUES (complex nested objects)...');
    for (const test of tests) {
        console.log(`  Running: ${test.name}`);
        const origResult = await runBenchmark(`${test.name} - Original`, BPlusTree, test.fn, generateLargeValue);
        const ptrResult = await runBenchmark(`${test.name} - Pointer`, BPlusTreePtr, test.fn, generateLargeValue);
        
        results['Large Values (complex objects)'][test.name] = {
            original: origResult,
            pointer: ptrResult
        };
    }
    
    formatResults(results);
    
    // Summary
    console.log('\nSUMMARY:');
    console.log('-'.repeat(100));
    console.log('The pointer-based approach should show:');
    console.log('  ✓ Better performance with large values (less data copying during splits)');
    console.log('  ✓ Similar or slightly worse performance with small values (extra indirection)');
    console.log('  ✗ Larger file sizes (values stored separately + pointer overhead)');
    console.log('  ✓ More I/O efficient for updates (only pointer changed, not entire node)');
    console.log('\nThe trade-off depends on your use case:');
    console.log('  - Large values + frequent updates → Use pointer-based approach');
    console.log('  - Small values + read-heavy → Use original approach');
    console.log('='.repeat(100));
}

main().catch(console.error);
