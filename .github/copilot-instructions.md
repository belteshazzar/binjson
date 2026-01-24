# Copilot Instructions for BJson

## Project Overview

BJson is a compact binary encoding library for JSON data with browser OPFS (Origin Private File System) support. It provides efficient serialization/deserialization and file operations for both Node.js and browser environments.

**Core architecture**: Single-file library ([binjson.js](../binjson.js)) with dual exports (CommonJS + browser globals) and custom binary protocol.

## Binary Encoding Protocol

The project implements a custom binary format using type-prefixed encoding:

- **Type byte system**: Each value starts with a type byte (0x00-0x11) from the `TYPE` constant
- **Little-endian throughout**: All multi-byte integers and floats use little-endian byte order
- **Length-prefixed structures**: Strings, arrays, and objects store their length as 32-bit unsigned integers before content
- **ObjectId special handling**: MongoDB ObjectIds (24-char hex strings) are stored as 12 bytes (type 0x06)
- **Date special handling**: JavaScript Date objects are encoded as 64-bit signed integer timestamps in milliseconds (type 0x07)

**Key encoding patterns in [binjson.js](../binjson.js)**:
- Numbers: Integers fitting in 32-bit signed range use TYPE.INT (5 bytes total), otherwise TYPE.FLOAT (9 bytes)
- Strings: TYPE.STRING + 4-byte length + UTF-8 bytes
- Dates: TYPE.DATE + 8-byte signed 64-bit integer (timestamp in milliseconds from Date.getTime())
- Arrays: TYPE.ARRAY + 4-byte length + recursively encoded elements
- Objects: TYPE.OBJECT + 4-byte key count + (4-byte key length + key bytes + encoded value) pairs

## Critical Implementation Details

### Dual Environment Support

The library must work in both Node.js and browsers via conditional exports:

```javascript
// CommonJS export (Node.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TYPE, ObjectId, encode, decode, BinJsonFile };
}

// Browser global
if (typeof window !== 'undefined') {
  window.BJson = { TYPE, ObjectId, encode, decode, BinJsonFile };
}
```

**When modifying**: Always export both ways. BinJsonFile OPFS operations only work in browsers, but the class must be exportable in Node.js for testing.

### Recursive Encoding Pattern

The `encode()` function uses a closure pattern with buffer accumulation:

```javascript
function encode(value) {
  const buffers = [];  // Accumulate Uint8Array chunks
  
  function encodeValue(val) {
    // Recursively encode, pushing to buffers
  }
  
  encodeValue(value);
  // Combine all buffers into single Uint8Array
}
```

**When adding types**: Add to TYPE constant, handle in both `encodeValue()` closure and `decode()` switch statement.

### OPFS File Operations

BinJsonFile uses lazy initialization pattern - `init()` is called by every public method:

```javascript
async init() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('OPFS not supported');
  }
  this.root = await navigator.storage.getDirectory();
}
```

**Append operation gotcha**: Uses `createWritable({ keepExistingData: true })` and `seek()` to append without rewriting entire file.

**Scan operation**: Custom byte-walking logic (`getValueSize()` nested function) to parse multiple top-level values without fully decoding each - critical for large files.

## Testing & Development

### Running Tests

```bash
node test.js
```

Test file ([test.js](../test.js)) uses custom assertion functions (not a framework):
- `assert()` - Boolean checks
- `assertEqual()` - Shallow equality  
- `assertDeepEqual()` - JSON stringification comparison
- `assertThrows()` - Error validation

**Testing pattern**: Each type has 3-5 tests covering basic round-trip, edge cases (max/min values), and error conditions. Complex structures tested at the end.

**When adding features**: Follow the test section pattern (console.log header, multiple assertions, blank line separator). Tests must run synchronously in Node.js (no OPFS tests in test.js).

### Demo Page

[demo.html](../demo.html) provides interactive browser testing - includes all OPFS operations since they can't run in Node.js tests. Use this to verify browser-specific functionality.

## Code Conventions

- **No external dependencies**: Pure JavaScript, no npm packages beyond devDependencies
- **Error messages**: Include context - e.g., `"File not found: ${this.filename}"` not just "File not found"
- **DataView for bytes**: Always use DataView for multi-byte reads/writes to handle endianness explicitly
- **Offset tracking**: decode() uses mutable `offset` variable - be careful with mutations in switch cases
- **Generator pattern**: Use async generators (`async *scan()`) for streaming large files

## Common Modifications

**Adding a new type**:
1. Add constant to `TYPE` object
2. Implement encoding in `encodeValue()` closure
3. Add case to `decode()` switch statement
4. Update `getValueSize()` in `scan()` method
5. Add type to README type table and write tests

**Browser compatibility**: OPFS requires Chrome 102+. Non-OPFS features (encode/decode) work in all modern browsers.

**File format stability**: Changes to encoding format break compatibility. Consider versioning or migration if modifying the binary protocol.
