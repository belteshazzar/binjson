# Quick Reference: BPlusTree vs BPlusTreePtr

## At a Glance

| Feature | BPlusTree (Original) | BPlusTreePtr (Pointer) |
|---------|---------------------|----------------------|
| **Storage Model** | Values in nodes | Values separate, pointers in nodes |
| **Best For** | Small values, reads | Large values, writes |
| **File Version** | 1 | 2 |
| **Node Size** | Variable (with values) | Fixed (pointers only) |
| **Memory Usage** | High (all values) | Low (lazy loading) |

## Performance with Large Values (~3KB objects)

| Operation | Original | Pointer | Winner |
|-----------|----------|---------|--------|
| Sequential Insert | 995ms | 445ms | **Pointer (55% faster)** ⚡ |
| Random Insert | 1186ms | 487ms | **Pointer (59% faster)** ⚡ |
| Mixed Ops | 1179ms | 612ms | **Pointer (48% faster)** ⚡ |
| Search Heavy | 6271ms | 2506ms | **Pointer (60% faster)** ⚡ |
| Range Queries | 22412ms | 12769ms | **Pointer (43% faster)** ⚡ |
| File Size | 10MB | 3.9MB | **Pointer (61% smaller)** 💾 |

## Performance with Small Values (~10 bytes strings)

| Operation | Original | Pointer | Winner |
|-----------|----------|---------|--------|
| Sequential Insert | 343ms | 315ms | **Pointer (8% faster)** ⚡ |
| Random Insert | 299ms | 273ms | **Pointer (8% faster)** ⚡ |
| Mixed Ops | 290ms | 313ms | **Original (7% faster)** |
| Search Heavy | 982ms | 1147ms | **Original (17% faster)** 🔍 |
| Range Queries | 3132ms | 3850ms | **Original (23% faster)** 🔍 |
| File Size | 1.4MB | 1.4MB | Tie (~4% difference) |

## Decision Matrix

### Choose BPlusTree (Original) When:

- ✅ Values are small (<100 bytes)
- ✅ Search/query performance is critical
- ✅ Sequential access patterns dominate
- ✅ Want simpler, battle-tested implementation
- ✅ Compatibility with version 1 files needed

**Example Use Cases:**
- Integer indexes
- Short string lookups
- Enum-based data
- Cached computed values
- Small configuration data

### Choose BPlusTreePtr (Pointer-based) When:

- ✅ Values are large (>1KB)
- ✅ Insert/update operations are frequent
- ✅ Memory is constrained
- ✅ Storage efficiency is important
- ✅ Random access patterns

**Example Use Cases:**
- Document storage
- User profiles with rich data
- JSON/XML documents
- Large metadata objects
- Media file metadata
- Complex nested structures

## API Compatibility

Both implementations have **identical APIs**:

```javascript
// Drop-in replacement
import { BPlusTree } from './bplustree.js';
// OR
import { BPlusTreePtr } from './bplustree-ptr.js';

// Same usage
const tree = new BPlusTree(syncHandle, order);
await tree.open();
await tree.add(key, value);
const result = await tree.search(key);
await tree.delete(key);
await tree.close();
```

## Migration Guide

### From Original to Pointer-based

```javascript
// Old code
const tree = new BPlusTree(syncHandle, order);

// New code (one line change)
const tree = new BPlusTreePtr(syncHandle, order);

// Everything else stays the same!
```

**Note**: Files are not compatible between versions. Must rebuild index.

### Value Size Threshold

When should you switch?

```
Value Size         Recommendation
--------------     ------------------
< 50 bytes         Original
50-500 bytes       Depends on workload
500-1000 bytes     Slightly favor Pointer
> 1000 bytes       Strongly favor Pointer
```

**Rule of thumb**: If average value size > 500 bytes, use pointer-based.

## Memory Footprint

**Per 1000 items with 3KB values:**

```
Original:     ~18MB in memory (loads all values)
Pointer:      ~3.2MB in memory (loads on demand)

Savings:      ~82% less memory usage
```

## Implementation Details

| Aspect | Original | Pointer-based |
|--------|----------|--------------|
| Value Storage | NodeData.values[] | Separate write + Pointer |
| Split Operation | Copy values | Copy pointers only |
| Search | Direct access | Dereference pointer |
| Update | Rewrite node | Rewrite pointer + new value |
| File Growth | Duplicates values | Appends new values |

## Code Size

| Metric | Count |
|--------|-------|
| Source lines (bplustree-ptr.js) | 542 |
| Test lines | 350 |
| Tests passing | 16/16 ✅ |
| Benchmark code | 300 |
| Documentation | 4 files |

## Quick Decision Tree

```
Start
  ↓
Are values typically > 1KB?
  ├─ Yes → Use BPlusTreePtr ✅
  └─ No
      ↓
  Are inserts/updates frequent?
      ├─ Yes → Use BPlusTreePtr ✅
      └─ No
          ↓
      Is search performance critical?
          ├─ Yes → Use BPlusTree (Original) ✅
          └─ No → Either works, prefer BPlusTreePtr for smaller files
```

## Summary Stats

### Pointer-based Wins (Large Values)

- 🏆 **55-60%** faster inserts
- 🏆 **43-60%** faster searches  
- 🏆 **61%** smaller files
- 🏆 **82%** less memory

### Original Wins (Small Values)

- 🏆 **17-23%** faster searches
- 🏆 Simpler implementation
- 🏆 Better cache locality
- 🏆 No pointer overhead

## Running Benchmarks

```bash
# Full comparison
node benchmark/bplustree-comparison.js

# Just your tests
npm test -- test/bplustree-ptr.test.js
```

## Documentation

- 📘 [Technical Analysis](bplustree-pointer-analysis.md)
- 📗 [Executive Summary](pointer-implementation-summary.md)
- 📙 [Visual Comparison](visual-comparison.md)
- 📕 [Benchmark Guide](../BENCHMARK_QUICKSTART.md)

## Last Updated

Generated from benchmark results on 2024-01-31
