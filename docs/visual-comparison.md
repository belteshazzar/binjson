# B+ Tree Storage Models: Visual Comparison

## Original BPlusTree (Value Objects in Nodes)

```
┌─────────────────────────────────────────────────────────────┐
│                        File Structure                        │
└─────────────────────────────────────────────────────────────┘

[Node 1: {keys: [1,2,3], values: [obj1, obj2, obj3]}]
[Node 2: {keys: [4,5,6], values: [obj4, obj5, obj6]}]
[Node 3: {keys: [7,8,9], values: [obj7, obj8, obj9]}]
[Metadata]

When a node splits:
- Copy entire arrays including large value objects
- Serialize all values in both old and new nodes
- More data to write to disk
```

### Node Split Example (Original)

```
Before split:
Node A: keys=[1,2,3,4,5,6] values=[V1,V2,V3,V4,V5,V6]
                                   ↓↓ Each V is a large object

After split:
Node A: keys=[1,2,3] values=[V1,V2,V3]  ← Copy 3 large objects
Node B: keys=[4,5,6] values=[V4,V5,V6]  ← Copy 3 large objects

Total data copied: ~18KB (if each object is ~3KB)
```

## BPlusTreePtr (Pointer-based Values)

```
┌─────────────────────────────────────────────────────────────┐
│                        File Structure                        │
└─────────────────────────────────────────────────────────────┘

[Value obj1]
[Value obj2]
[Value obj3]
...
[Node 1: {keys: [1,2,3], valuePointers: [Ptr→obj1, Ptr→obj2, Ptr→obj3]}]
[Node 2: {keys: [4,5,6], valuePointers: [Ptr→obj4, Ptr→obj5, Ptr→obj6]}]
[Node 3: {keys: [7,8,9], valuePointers: [Ptr→obj7, Ptr→obj8, Ptr→obj9]}]
[Metadata]

When a node splits:
- Copy only 8-byte pointers
- Values stay in place (no duplication)
- Much less data to write to disk
```

### Node Split Example (Pointer-based)

```
Before split:
Node A: keys=[1,2,3,4,5,6] valuePointers=[P1,P2,P3,P4,P5,P6]
                                          ↓↓ Each P is 8 bytes

After split:
Node A: keys=[1,2,3] valuePointers=[P1,P2,P3]  ← Copy 3 pointers (24 bytes)
Node B: keys=[4,5,6] valuePointers=[P4,P5,P6]  ← Copy 3 pointers (24 bytes)

Total data copied: 48 bytes
Speedup: ~375x less data copied!
```

## Search Operation Comparison

### Original Approach

```
Search(key=5):
1. Load Node 2 from disk
   ↓ Deserialize entire node with all values (~18KB)
2. Find key=5 in keys array
3. Return values[2] (already in memory)
   
Total I/O: ~18KB
Total operations: 1 node load
```

### Pointer-based Approach

```
Search(key=5):
1. Load Node 2 from disk
   ↓ Deserialize node with pointers (~200 bytes)
2. Find key=5 in keys array
3. Load value from valuePointers[2]
   ↓ Deserialize value (~3KB)
4. Return value

Total I/O: ~3.2KB
Total operations: 1 node load + 1 value load
```

## Performance Comparison Chart

```
Insertion Performance (1000 items, large values)

Original:  ████████████████████ 995ms
Pointer:   █████████ 445ms (55% faster)

Search Performance (2500 searches, large values)

Original:  ██████████████████████████████ 6271ms
Pointer:   ████████████ 2506ms (60% faster)

File Size (1000 items, large values)

Original:  ██████████████████████████████ 10MB
Pointer:   ███████████ 3.9MB (61% smaller)
```

## Memory Usage Pattern

### Original (Load entire node)

```
Memory:
┌──────────────────────────────────────┐
│ Node structure: 200 bytes            │
│ All values: 3KB × 6 = 18KB          │
│ Total: 18.2KB per node in memory    │
└──────────────────────────────────────┘
```

### Pointer-based (Load on demand)

```
Memory:
┌──────────────────────────────────────┐
│ Node structure: 200 bytes            │
│ Pointers: 8 bytes × 6 = 48 bytes    │
│ Current value: 3KB                   │
│ Total: 3.2KB per lookup             │
└──────────────────────────────────────┘

Memory savings: ~84% reduction
```

## Trade-off Summary

### When to Use Original

```
✅ Small values (<100 bytes)
   - Pointer overhead not worth it
   - Direct access is faster

✅ Read-heavy workload
   - All values loaded together
   - No extra I/O for values

✅ Cache-friendly access patterns
   - Sequential scans benefit from locality
```

### When to Use Pointer-based

```
✅ Large values (>1KB)
   - Huge reduction in data copying
   - Significant performance gains

✅ Insert/update-heavy workload
   - Less data movement during splits
   - Only pointers need updating

✅ Memory-constrained environment
   - Lazy loading of values
   - Smaller memory footprint

✅ Selective access patterns
   - Load only what you need
   - No wasted I/O
```

## Real-world Analogy

### Original Approach (Library with Attached Books)

```
📚 Each shelf has books permanently attached
  ├─ To rearrange: must move entire books
  ├─ To read one: get entire shelf
  └─ Heavy lifting for every change
```

### Pointer-based Approach (Library with Book Cards)

```
📇 Each shelf has index cards with locations
  ├─ To rearrange: just move small cards
  ├─ To read one: follow card to book location
  └─ Light lifting, fetch book only when needed
```

## Conclusion

The pointer-based approach is like having a library catalog system - you maintain a lightweight index and fetch the actual content only when needed. This is much more efficient when the content (values) is large compared to the index (keys + pointers).

For small values, the overhead of maintaining and following pointers isn't worth it - it's like having a catalog for a bookshelf in your bedroom. But for large values, it's like having a catalog for a warehouse - essential for performance.
