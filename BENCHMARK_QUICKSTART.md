# Quick Start: Running the Performance Benchmark

This guide shows you how to run the B+ tree performance comparison.

## Prerequisites

```bash
npm install
```

## Run the Benchmark

```bash
node benchmark/bplustree-comparison.js
```

The benchmark takes 2-3 minutes and tests both implementations with:
- Small values (strings)
- Large values (complex nested objects)

## Expected Output

```
====================================================================================================
PERFORMANCE COMPARISON RESULTS
====================================================================================================

SMALL VALUES (STRINGS):
----------------------------------------------------------------------------------------------------

Sequential Inserts (1000):
  Original: 343.08ms, 1387.29KB
  Pointer:  315.23ms, 1442.09KB
  Speedup:  +8.1% faster
  Size:     103.9% of original

...

LARGE VALUES (COMPLEX OBJECTS):
----------------------------------------------------------------------------------------------------

Sequential Inserts (1000):
  Original: 995.24ms, 10092.40KB
  Pointer:  444.88ms, 3932.11KB
  Speedup:  +55.3% faster
  Size:     39.0% of original

...
====================================================================================================
```

## Interpreting Results

### Key Metrics

- **Duration**: Time to complete the operation
- **File Size**: Total bytes written to storage
- **Speedup**: Positive = pointer-based is faster
- **Size ratio**: Percentage compared to original

### What to Look For

1. **Large value performance**: Pointer-based should be 50-60% faster
2. **Small value searches**: Original should be 10-20% faster
3. **File sizes**: Pointer-based creates smaller files with large values

## Running Individual Tests

You can modify the benchmark script to run specific tests:

```javascript
// Edit benchmark/bplustree-comparison.js

const tests = [
    // Comment out tests you don't want to run
    { name: 'Sequential Inserts (1000)', fn: (t, v) => sequentialInserts(t, v, 1000) },
    // { name: 'Random Inserts (1000)', fn: (t, v) => randomInserts(t, v, 1000) },
];
```

## Troubleshooting

### "node-opfs not found"

```bash
npm install
```

### Tests run too slowly

Reduce the iteration counts in the benchmark:

```javascript
// Change from 1000 to 100
{ name: 'Sequential Inserts (100)', fn: (t, v) => sequentialInserts(t, v, 100) }
```

### Memory issues

The benchmark creates temporary files. If you encounter memory issues:

1. Run tests one at a time
2. Reduce iteration counts
3. Ensure you have at least 1GB free RAM

## Learn More

- See [docs/bplustree-pointer-analysis.md](../docs/bplustree-pointer-analysis.md) for detailed analysis
- See [benchmark/README.md](../benchmark/README.md) for benchmark documentation
- Run tests with `npm test -- test/bplustree-ptr.test.js` to verify the implementation
