# Binary JSON (binjson)

A compact binary encoding format for JSON data with support for Origin Private File System (OPFS) in browsers. This library enables efficient storage and retrieval of JSON data in a binary format.

## Features

- 🚀 **Compact Binary Format**: Efficient binary encoding of JSON data
- 💾 **OPFS Support**: Read and write binary JSON files using Origin Private File System
- 🔄 **Full Round-trip**: Encoding and decoding of all JSON types
- 📦 **MongoDB ObjectId Support**: Native support for MongoDB ObjectIds (24-character hex strings)
- 🎯 **File Pointer Support**: Built-in Pointer type for storing 64-bit file offsets for indexed data access
- 🔍 **File Scanning**: Ability to scan through files and read records sequentially
- ➕ **Append Operations**: Append new records to existing files
- 🌐 **Browser & Node.js**: Works in both browser and Node.js environments

## Type Encoding

The library uses the following byte values for encoding JSON types:

| Type    | Byte Value | Data Format                                          |
|---------|-----------|------------------------------------------------------|
| NULL    | 0x00      | No additional data                                   |
| FALSE   | 0x01      | No additional data                                   |
| TRUE    | 0x02      | No additional data                                   |
| INT     | 0x03      | 4 bytes (32-bit signed integer, little-endian)      |
| FLOAT   | 0x04      | 8 bytes (64-bit float, little-endian)               |
| STRING  | 0x05      | 4-byte length + UTF-8 encoded bytes                 |
| OID     | 0x06      | 12 bytes (MongoDB ObjectId)                         |
| DATE    | 0x07      | 8 bytes (64-bit signed integer milliseconds, little-endian) |
| POINTER | 0x08      | 8 bytes (64-bit non-negative integer file offset, little-endian) |
| BINARY  | 0x09      | 4-byte length + raw binary bytes                    |
| ARRAY   | 0x10      | 4-byte length + encoded elements                    |
| OBJECT  | 0x11      | 4-byte count + key-value pairs                      |

## Installation

### Node.js

```bash
npm install @belteshazzar/binjson
```

### Browser

Include the script in your HTML:

```html
<script src="binjson.js"></script>
```

## Usage

### Basic Encoding and Decoding

```javascript
const { encode, decode } = require('./binjson.js');

// Encode data to binary
const data = { name: 'John', age: 30, active: true };
const binary = encode(data);

// Decode binary back to data
const decoded = decode(binary);
console.log(decoded); // { name: 'John', age: 30, active: true }
```

### Using MongoDB ObjectId

```javascript
const { ObjectId, encode, decode } = require('./binjson.js');

const data = {
  _id: new ObjectId('507f1f77bcf86cd799439011'),
  name: 'Document'
};

const binary = encode(data);
const decoded = decode(binary);

console.log(decoded._id.toString()); // '507f1f77bcf86cd799439011'
```

### Using Date Objects

```javascript
const { encode, decode } = require('./binjson.js');

const data = {
  timestamp: new Date('2023-01-15T12:30:45Z'),
  message: 'Hello'
};

const binary = encode(data);
const decoded = decode(binary);

console.log(decoded.timestamp); // Date object: 2023-01-15T12:30:45.000Z
console.log(decoded.message); // 'Hello'
```

### Using Binary Data (Uint8Array)

```javascript
const { encode, decode } = require('./binjson.js');

// Encode binary data
const binaryData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
const encoded = encode(binaryData);
const decoded = decode(encoded);

console.log(decoded); // Uint8Array [0xDE, 0xAD, 0xBE, 0xEF]

// Binary data in objects
const data = {
  name: 'image.png',
  content: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), // PNG header
  size: 4
};

const binaryEncoded = encode(data);
const binaryDecoded = decode(binaryEncoded);

console.log(binaryDecoded.content); // Uint8Array [0x89, 0x50, 0x4E, 0x47]
```

### Using Pointer for File Offsets

```javascript
const { Pointer, encode, decode } = require('./binjson.js');

// Create an index record with a pointer to data at offset 2048
const indexRecord = {
  key: 'user_123',
  dataOffset: new Pointer(2048)
};

const binary = encode(indexRecord);
const decoded = decode(binary);

console.log(decoded.dataOffset.valueOf()); // 2048
// Use the pointer to seek to that position in a file and read data
```

### OPFS File Operations (Web Worker Only)

**Important**: 
- `BinJsonFile` uses `FileSystemSyncAccessHandle` which is **only available in Web Workers**
- Files must be explicitly opened before use and closed when done
- A single file handle is used for all read/write operations, improving performance
- Changes are automatically flushed to disk after each write/append operation
- Files can be opened in two modes:
  - `'r'` - Read-only mode (file must exist)
  - `'rw'` - Read-write mode (file created if it doesn't exist)

See [FILE-MODE-API.md](FILE-MODE-API.md) for detailed documentation.

#### Write to File

```javascript
// In a Web Worker:
const { BinJsonFile } = self.BJson;

const file = new BinJsonFile('data.bj');
await file.open('rw');  // Open in read-write mode

const data = { name: 'John', age: 30 };
await file.write(data);  // Automatically flushed to disk

await file.close();
```

#### Read from File

```javascript
// In a Web Worker:
const file = new BinJsonFile('data.bj');
await file.open('r');  // Open in read-only mode

const data = await file.read();
console.log(data); // { name: 'John', age: 30 }

await file.close();
```

#### Append to File

```javascript
// In a Web Worker:
const file = new BinJsonFile('data.bj');
await file.open('rw');  // Open in read-write mode

// Write initial record
await file.write({ id: 1, name: 'Record 1' });

// Append more records (same file handle - efficient!)
await file.append({ id: 2, name: 'Record 2' });
await file.append({ id: 3, name: 'Record 3' });

await file.close();
```

#### Scan File (Read All Records)

```javascript
// In a Web Worker:
const file = new BinJsonFile('data.bj');
await file.open('r');  // Open in read-only mode

for (const record of file.scan()) {
  console.log(record);
}
// Output:
// { id: 1, name: 'Record 1' }
// { id: 2, name: 'Record 2' }
// { id: 3, name: 'Record 3' }

await file.close();
```

#### Other File Operations

```javascript
// In a Web Worker:
const file = new BinJsonFile('data.bj');

// Check if file exists (doesn't require opening)
const exists = await file.exists();
console.log(exists); // true or false

// Delete file (requires read-write mode)
await file.open('rw');
await file.delete();  // Automatically closes after deletion

// Explicit flush (write/append already auto-flush)
await file.open('rw');
await file.write({ data: 'example' });
// ... more operations ...
await file.flush();  // Ensure all writes are persisted
await file.close();
```

#### Reusing File Handles

A single `FileSystemSyncAccessHandle` is used for all operations once opened, making multiple operations very efficient:

```javascript
// In a Web Worker:
const file = new BinJsonFile('data.bj');
await file.open('rw');  // Opens once with a single sync access handle

// Multiple operations on the same handle - no need to reopen!
await file.write({ id: 1 });
await file.append({ id: 2 });
await file.append({ id: 3 });

// Read back from same handle
const data = await file.read();

// Scan without re-opening
for (const record of file.scan()) {
  console.log(record);
}

await file.close();  // Flushes and closes the single handle
```

## Browser Support

The OPFS functionality with `FileSystemSyncAccessHandle` requires:

- **Web Worker context** (not available on main thread)
- Chrome 102+
- Edge 102+
- Opera 88+
- Other Chromium-based browsers

For other browsers or main thread usage, the encoding and decoding functions work normally, but file operations are not available.

## Demo

Open `demo.html` in a supported browser to see an interactive demonstration of all features.

## API Reference

### `encode(value)`

Encodes a JavaScript value to binary format.

- **Parameters**: `value` - Any JSON-serializable value (including ObjectId)
- **Returns**: `Uint8Array` - Binary encoded data

### `decode(data)`

Decodes binary data to a JavaScript value.

- **Parameters**: `data` - `Uint8Array` containing binary encoded data
- **Returns**: Decoded JavaScript value

### `ObjectId`

Class representing a MongoDB ObjectId.

#### Constructor

```javascript
new ObjectId(value)
```

- **Parameters**: 
  - `value` - Either a 24-character hex string or 12-byte Uint8Array

#### Methods

- `toString()` - Returns the ObjectId as a 24-character hex string
- `toBytes()` - Returns the ObjectId as a 12-byte Uint8Array
- `static isValid(value)` - Checks if a string is a valid ObjectId format

### `Pointer`

Class representing a file offset pointer.

#### Constructor

```javascript
new Pointer(offset)
```

- **Parameters**: 
  - `offset` - A non-negative integer representing a file byte offset (must be within Number.MAX_SAFE_INTEGER)

#### Methods

- `valueOf()` - Returns the offset as a number
- `toString()` - Returns the offset as a string
- `toJSON()` - Returns the offset as a number for JSON serialization
- `equals(other)` - Compares this Pointer with another for equality

### `BinJsonFile`

Class for OPFS file operations using `FileSystemSyncAccessHandle`.

**Important**: 
- Must be used in a **Web Worker context** only
- Uses a single persistent file handle for all operations
- Files must be opened before use and closed when done
- All write/append operations automatically flush to disk

See [FILE-MODE-API.md](FILE-MODE-API.md) for detailed documentation.

#### Constructor

```javascript
new BinJsonFile(filename)
```

- **Parameters**: `filename` - Name of the file in OPFS

#### Methods

- `async open(mode)` - Open file in specified mode and create sync access handle
  - `mode` - `'r'` for read-only (file must exist) or `'rw'` for read-write (creates if needed)
  - Throws error if file already open, if file not found in read mode, or if not in a Web Worker
  - Creates a single `FileSystemSyncAccessHandle` for all subsequent operations
- `async close()` - Flush pending writes, close the sync access handle, and release resources
- `async write(data)` - Write data to file (overwrites existing, requires 'rw' mode, auto-flushes)
- `async read(pointer)` - Read and decode data from file (requires file to be open)
  - `pointer` - Optional Pointer offset to start reading from (default: 0)
- `async append(data)` - Append data to existing file (requires 'rw' mode, auto-flushes)
- `async flush()` - Explicitly flush any pending writes to disk (write/append already auto-flush)
- `async *scan()` - Async generator to scan through all records (requires file to be open)
- `async delete()` - Delete the file (requires 'rw' mode, auto-closes after)
- `async exists()` - Check if file exists (can be called without opening)

#### Access Control

- **Read-only mode (`'r'`)**:
  - Can use: `read()`, `scan()`, `getFileSize()`, `readRange()`
  - Cannot use: `write()`, `append()`, `delete()` (will throw errors)
  
- **Read-write mode (`'rw'`)**:
  - Can use all methods
  - File is created if it doesn't exist

## Examples

### Complex Data Structure

```javascript
const { ObjectId, encode, decode } = require('./binjson.js');

const document = {
  _id: new ObjectId('507f1f77bcf86cd799439011'),
  name: 'Product',
  price: 99.99,
  inStock: true,
  tags: ['electronics', 'featured'],
  metadata: {
    created: 1234567890,
    updated: null,
    stats: {
      views: 1500,
      purchases: 42
    }
  },
  reviews: [
    { rating: 5, comment: 'Great product!' },
    { rating: 4, comment: 'Good value' }
  ]
};

const binary = encode(document);
console.log(`Encoded size: ${binary.length} bytes`);

const decoded = decode(binary);
console.log(decoded);
```

### Batch File Operations

```javascript
const file = new BinJsonFile('products.bj');
await file.open('rw');  // Open once for multiple operations

// Write multiple products
const products = [
  { id: 1, name: 'Product 1', price: 10.00 },
  { id: 2, name: 'Product 2', price: 20.00 },
  { id: 3, name: 'Product 3', price: 30.00 }
];

// Write first product
await file.write(products[0]);

// Append remaining products (same file handle)
for (let i = 1; i < products.length; i++) {
  await file.append(products[i]);
}

// Read all products (same file handle)
const allProducts = [];
for (const product of file.scan()) {
  allProducts.push(product);
}

console.log(allProducts);

await file.close();
```

### Using Pointers for File Seeking

```javascript
const { Pointer, encode, decode } = require('./binjson.js');
const fs = require('fs');

// Scenario: Build an index of records with pointers to actual data locations

// Step 1: Write data records and track their offsets
const records = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com' }
];

const dataFile = 'data.bj';
const indexFile = 'index.bj';
const index = [];

// Write records and build index
let currentOffset = 0;
const dataBuffer = [];

for (const record of records) {
  const encoded = encode(record);
  dataBuffer.push(encoded);
  
  // Store index entry with pointer to data location
  index.push({
    id: record.id,
    name: record.name,
    dataPointer: new Pointer(currentOffset)
  });
  
  currentOffset += encoded.length;
}

// Write data file
const allData = new Uint8Array(currentOffset);
let writeOffset = 0;
for (const buf of dataBuffer) {
  allData.set(buf, writeOffset);
  writeOffset += buf.length;
}
fs.writeFileSync(dataFile, allData);

// Write index file
const indexEncoded = encode(index);
fs.writeFileSync(indexFile, indexEncoded);

// Step 2: Use the index to seek and read specific records
const indexData = decode(fs.readFileSync(indexFile));
const fullDataFile = fs.readFileSync(dataFile);

// Find and read record with id: 2
const indexEntry = indexData.find(entry => entry.id === 2);
const offset = indexEntry.dataPointer.valueOf();

// Seek to offset and decode the record
// Note: In a real implementation, you'd need to determine the record size
// For this example, we'll read a known-size chunk
const recordData = fullDataFile.slice(offset); // In practice, you'd know the size
const record = decode(recordData);

console.log(record); // { id: 2, name: 'Bob', email: 'bob@example.com' }
```

## Browser Demos

The `public/` directory contains interactive HTML demos that showcase OPFS integration. These demos use Web Workers with `FileSystemSyncAccessHandle` for efficient file operations.

### Building

The demos require a build step to bundle the worker with its dependencies (including the `stemmer` npm package):

```bash
npm run build:worker
```

This creates `dist/worker.js` which bundles all necessary dependencies.

### Running Demos

1. Build the worker: `npm run build:worker`
2. Start the dev server: `npm run serve`
3. Open http://localhost:8080/public/ in your browser (Chrome 102+ or Edge 102+ required for OPFS support)

Available demos:
- **binjson.html**: Basic encoding, file operations (write, read, append, scan, delete)
- **bplustree-compact.html**: B+ tree index with compaction
- **rtree-compact.html**: R-tree spatial index with geographic queries
- **textindex-compact.html**: Full-text search index with BM25 ranking

## Testing

Run the test suite:

```bash
node test.js
```

## License

BSD 2-Clause License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.