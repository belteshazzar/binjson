# B+ Tree Performance Benchmarks

This directory contains performance benchmarks for comparing different B+ tree implementations.

## Available Benchmarks

### bplustree-comparison.js

Compares the original BPlusTree (values stored in nodes) vs BPlusTreePtr (pointer-based values).

**Run the benchmark:**

```bash
node benchmark/bplustree-comparison.js
```

**What it tests:**

1. **Small values** (simple strings ~10 bytes)
   - Sequential inserts (1000 items)
   - Random inserts (1000 items)
   - Mixed operations (inserts + searches)
   - Search-heavy workload
   - Range searches

2. **Large values** (complex objects ~3KB each)
   - Same test suite as small values

**Output:**

- Execution time for each test
- File size comparison
- Performance speedup/slowdown percentages
- Summary with recommendations

**Expected results:**

- Pointer-based: 50-60% faster with large values
- Original: 10-20% faster with small values on searches
- Pointer-based: 60% smaller file sizes with large values

See [docs/bplustree-pointer-analysis.md](../docs/bplustree-pointer-analysis.md) for detailed analysis.

## Requirements

- Node.js (v14+)
- node-opfs package (installed via npm)

## Adding New Benchmarks

To add a new benchmark:

1. Create a new `.js` file in this directory
2. Import the necessary tree implementations
3. Set up node-opfs for OPFS support
4. Define test scenarios and measurements
5. Format and output results
6. Update this README

## Notes

- Benchmarks use node-opfs to emulate OPFS in Node.js
- File operations are performed in-memory for consistent results
- Timing uses `performance.now()` for high-resolution measurements
- Each test creates and cleans up temporary files
