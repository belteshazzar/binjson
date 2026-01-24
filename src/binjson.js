/**
 * Binary JSON Encoder/Decoder
 * 
 * Encodes JavaScript values to a compact binary format compatible with
 * Origin Private File System (OPFS).
 */

const TYPE = {
  NULL: 0x00,
  FALSE: 0x01,
  TRUE: 0x02,
  INT: 0x03,
  FLOAT: 0x04,
  STRING: 0x05,
  OID: 0x06,
  DATE: 0x07,
  POINTER: 0x08,
  BINARY: 0x09,
  ARRAY: 0x10,
  OBJECT: 0x11
};


/**
 * ObjectId class - MongoDB-compatible 24-character hex string identifier
 * Format: 8-char timestamp + 16-char random data
 */
class ObjectId {
  constructor(id) {
    if (id === undefined || id === null) {
      // Generate new ObjectId
      this.id = ObjectId.generate();
    } else if (typeof id === 'string') {
      // Create from hex string
      if (!ObjectId.isValid(id)) {
        throw new Error(`Argument passed in must be a string of 24 hex characters, got: ${id}`);
      }
      this.id = id.toLowerCase();
    } else if (id instanceof Uint8Array && id.length === 12) {
      this.id = Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (id instanceof ObjectId) {
      // Copy constructor
      this.id = id.id;
    } else {
      throw new Error(`Argument passed in must be a string of 24 hex characters or an ObjectId`);
    }
  }

  /**
   * Returns the ObjectId as a 24-character hex string
   */
  toString() {
    return this.id;
  }

  /**
   * Returns the ObjectId as a 24-character hex string (alias for toString)
   */
  toHexString() {
    return this.id;
  }

  /**
   * Returns the timestamp portion of the ObjectId as a Date
   */
  getTimestamp() {
    const timestamp = parseInt(this.id.substring(0, 8), 16);
    return new Date(timestamp * 1000);
  }

  equals(other) {
    if (!(other instanceof ObjectId)) {
      throw new Error('Can only compare with another ObjectId');
    }
    return this.id === other.id;
  }

  /**
   * Compares this ObjectId with another for equality
   */
  compare(other) {
    if (!(other instanceof ObjectId)) {
      throw new Error('Can only compare with another ObjectId');
    }

    return this.id.localeCompare(other.id);
  }

  /**
   * Returns the ObjectId in JSON format (as hex string)
   */
  toJSON() {
    return this.id;
  }

  /**
   * Custom inspect for Node.js console.log
   */
  inspect() {
    return `ObjectId("${this.id}")`;
  }

  toBytes() {
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      bytes[i] = parseInt(this.id.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /**
   * Validates if a string is a valid ObjectId hex string
   */
  static isValid(id) {
    if (!id) return false;
    if (typeof id !== 'string') return false;
    if (id.length !== 24) return false;
    return /^[0-9a-fA-F]{24}$/.test(id);
  }

  /**
   * Creates an ObjectId from a timestamp
   */
  static createFromTime(timestamp) {
    const ts = Math.floor(timestamp / 1000);
    const tsHex = ('00000000' + ts.toString(16)).slice(-8);
    const tail = '0000000000000000'; // Zero out the random portion
    return new ObjectId(tsHex + tail);
  }

  /**
   * Generates a new ObjectId hex string
   * Format: 8-char timestamp (4 bytes) + 16-char random data (8 bytes)
   */
  static generate() {
    const ts = Math.floor(Date.now() / 1000);
    
    // Generate 8 random bytes
    const rand = typeof crypto !== 'undefined' && crypto.getRandomValues ? new Uint8Array(8) : null;
    let tail = '';
    
    if (rand) {
      crypto.getRandomValues(rand);
      for (let i = 0; i < rand.length; i++) {
        tail += ('0' + rand[i].toString(16)).slice(-2);
      }
    } else {
      // Fallback for environments without crypto
      // Generate two 8-character hex strings
      tail = Math.random().toString(16).slice(2).padEnd(8, '0').slice(0, 8) +
             Math.random().toString(16).slice(2).padEnd(8, '0').slice(0, 8);
    }
    
    const tsHex = ('00000000' + ts.toString(16)).slice(-8);
    return (tsHex + tail).slice(0, 24);
  }
}

/**
 * Pointer class - represents a 64-bit file offset pointer
 * Used to store file offsets for referenced data structures
 */
class Pointer {
  constructor(offset) {
    if (offset === undefined || offset === null) {
      throw new Error('Pointer offset must be a number');
    }
    if (typeof offset !== 'number') {
      throw new Error('Pointer offset must be a number');
    }
    if (!Number.isInteger(offset)) {
      throw new Error('Pointer offset must be an integer');
    }
    if (offset < 0) {
      throw new Error('Pointer offset must be non-negative');
    }
    if (offset > Number.MAX_SAFE_INTEGER) {
      throw new Error('Pointer offset exceeds maximum safe integer');
    }
    this.offset = offset;
  }

  /**
   * Returns the pointer offset as a number
   */
  valueOf() {
    return this.offset;
  }

  /**
   * Returns the pointer offset as a string
   */
  toString() {
    return this.offset.toString();
  }

  /**
   * Returns the pointer in JSON format (as number)
   */
  toJSON() {
    return this.offset;
  }

  /**
   * Custom inspect for Node.js console.log
   */
  inspect() {
    return `Pointer(${this.offset})`;
  }

  /**
   * Compares this Pointer with another for equality
   */
  equals(other) {
    if (!(other instanceof Pointer)) {
      return false;
    }
    return this.offset === other.offset;
  }
}

/**
 * Encode a JavaScript value to binary format
 */
function encode(value) {
  const buffers = [];

  function encodeValue(val) {
    if (val === null) {
      buffers.push(new Uint8Array([TYPE.NULL]));
    } else if (val === false) {
      buffers.push(new Uint8Array([TYPE.FALSE]));
    } else if (val === true) {
      buffers.push(new Uint8Array([TYPE.TRUE]));
    } else if (val instanceof ObjectId) {
      buffers.push(new Uint8Array([TYPE.OID]));
      buffers.push(val.toBytes());
    } else if (val instanceof Date) {
      buffers.push(new Uint8Array([TYPE.DATE]));
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigInt64(0, BigInt(val.getTime()), true); // little-endian
      buffers.push(new Uint8Array(buffer));
    } else if (val instanceof Pointer) {
      buffers.push(new Uint8Array([TYPE.POINTER]));
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigUint64(0, BigInt(val.offset), true); // little-endian
      buffers.push(new Uint8Array(buffer));
    } else if (val instanceof Uint8Array) {
      buffers.push(new Uint8Array([TYPE.BINARY]));
      // Store length as 32-bit integer
      const lengthBuffer = new ArrayBuffer(4);
      const lengthView = new DataView(lengthBuffer);
      lengthView.setUint32(0, val.length, true);
      buffers.push(new Uint8Array(lengthBuffer));
      buffers.push(val);
    } else if (typeof val === 'number') {
      if (Number.isInteger(val) && Number.isSafeInteger(val)) {
        // 64-bit signed integer (stored as BigInt64)
        buffers.push(new Uint8Array([TYPE.INT]));
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setBigInt64(0, BigInt(val), true); // little-endian
        buffers.push(new Uint8Array(buffer));
      } else {
        // 64-bit float
        buffers.push(new Uint8Array([TYPE.FLOAT]));
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setFloat64(0, val, true); // little-endian
        buffers.push(new Uint8Array(buffer));
      }
    } else if (typeof val === 'string') {
      buffers.push(new Uint8Array([TYPE.STRING]));
      const encoded = new TextEncoder().encode(val);
      // Store length as 32-bit integer
      const lengthBuffer = new ArrayBuffer(4);
      const lengthView = new DataView(lengthBuffer);
      lengthView.setUint32(0, encoded.length, true);
      buffers.push(new Uint8Array(lengthBuffer));
      buffers.push(encoded);
    } else if (Array.isArray(val)) {
      // Encode array to temporary buffer to determine size
      const tempBuffers = [];
      
      // Store array length as 32-bit integer
      const lengthBuffer = new ArrayBuffer(4);
      const lengthView = new DataView(lengthBuffer);
      lengthView.setUint32(0, val.length, true);
      tempBuffers.push(new Uint8Array(lengthBuffer));
      
      // Encode each element into temp buffer
      const startLength = buffers.length;
      for (const item of val) {
        encodeValue(item);
      }
      // Collect encoded elements
      const elementBuffers = buffers.splice(startLength);
      tempBuffers.push(...elementBuffers);
      
      // Calculate total size of array content
      const contentSize = tempBuffers.reduce((sum, buf) => sum + buf.length, 0);
      
      // Now write: TYPE + SIZE + CONTENT
      buffers.push(new Uint8Array([TYPE.ARRAY]));
      const sizeBuffer = new ArrayBuffer(4);
      const sizeView = new DataView(sizeBuffer);
      sizeView.setUint32(0, contentSize, true);
      buffers.push(new Uint8Array(sizeBuffer));
      buffers.push(...tempBuffers);
    } else if (typeof val === 'object') {
      // Encode object to temporary buffer to determine size
      const tempBuffers = [];
      
      const keys = Object.keys(val);
      // Store number of keys as 32-bit integer
      const lengthBuffer = new ArrayBuffer(4);
      const lengthView = new DataView(lengthBuffer);
      lengthView.setUint32(0, keys.length, true);
      tempBuffers.push(new Uint8Array(lengthBuffer));
      
      // Encode each key-value pair into temp buffer
      const startLength = buffers.length;
      for (const key of keys) {
        // Encode key as string (without type byte)
        const encoded = new TextEncoder().encode(key);
        const keyLengthBuffer = new ArrayBuffer(4);
        const keyLengthView = new DataView(keyLengthBuffer);
        keyLengthView.setUint32(0, encoded.length, true);
        buffers.push(new Uint8Array(keyLengthBuffer));
        buffers.push(encoded);
        // Encode value
        encodeValue(val[key]);
      }
      // Collect encoded key-value pairs
      const kvBuffers = buffers.splice(startLength);
      tempBuffers.push(...kvBuffers);
      
      // Calculate total size of object content
      const contentSize = tempBuffers.reduce((sum, buf) => sum + buf.length, 0);
      
      // Now write: TYPE + SIZE + CONTENT
      buffers.push(new Uint8Array([TYPE.OBJECT]));
      const sizeBuffer = new ArrayBuffer(4);
      const sizeView = new DataView(sizeBuffer);
      sizeView.setUint32(0, contentSize, true);
      buffers.push(new Uint8Array(sizeBuffer));
      buffers.push(...tempBuffers);
    } else {
      throw new Error(`Unsupported type: ${typeof val}`);
    }
  }

  encodeValue(value);

  // Combine all buffers
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}

/**
 * Decode binary data to JavaScript value
 */
function decode(data) {
  let offset = 0;

  function decodeValue() {
    if (offset >= data.length) {
      throw new Error('Unexpected end of data');
    }

    const type = data[offset++];

    switch (type) {
      case TYPE.NULL:
        return null;
      
      case TYPE.FALSE:
        return false;
      
      case TYPE.TRUE:
        return true;
      
      case TYPE.INT: {
        if (offset + 4 > data.length) {
          throw new Error('Unexpected end of data for INT');
        }
        const view = new DataView(data.buffer, data.byteOffset + offset, 8);
        const value = view.getBigInt64(0, true);
        offset += 8;
        if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Decoded integer exceeds safe range');
        }
        return Number(value);
      }
      
      case TYPE.FLOAT: {
        if (offset + 8 > data.length) {
          throw new Error('Unexpected end of data for FLOAT');
        }
        const view = new DataView(data.buffer, data.byteOffset + offset, 8);
        const value = view.getFloat64(0, true);
        offset += 8;
        return value;
      }
      
      case TYPE.STRING: {
        if (offset + 4 > data.length) {
          throw new Error('Unexpected end of data for STRING length');
        }
        const lengthView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const length = lengthView.getUint32(0, true);
        offset += 4;
        
        if (offset + length > data.length) {
          throw new Error('Unexpected end of data for STRING content');
        }
        const stringData = data.slice(offset, offset + length);
        offset += length;
        return new TextDecoder().decode(stringData);
      }
      
      case TYPE.OID: {
        if (offset + 12 > data.length) {
          throw new Error('Unexpected end of data for OID');
        }
        const oidBytes = data.slice(offset, offset + 12);
        offset += 12;
        return new ObjectId(oidBytes);
      }

      case TYPE.DATE: {
        if (offset + 8 > data.length) {
          throw new Error('Unexpected end of data for DATE');
        }
        const view = new DataView(data.buffer, data.byteOffset + offset, 8);
        const timestamp = view.getBigInt64(0, true);
        offset += 8;
        return new Date(Number(timestamp));
      }
      
      case TYPE.POINTER: {
        if (offset + 8 > data.length) {
          throw new Error('Unexpected end of data for POINTER');
        }
        const view = new DataView(data.buffer, data.byteOffset + offset, 8);
        const pointerOffset = view.getBigUint64(0, true);
        offset += 8;
        // Validate offset is within safe integer range
        if (pointerOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Pointer offset out of valid range');
        }
        return new Pointer(Number(pointerOffset));
      }
      
      case TYPE.BINARY: {
        if (offset + 4 > data.length) {
          throw new Error('Unexpected end of data for BINARY length');
        }
        const lengthView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const length = lengthView.getUint32(0, true);
        offset += 4;
        
        if (offset + length > data.length) {
          throw new Error('Unexpected end of data for BINARY content');
        }
        const binaryData = data.slice(offset, offset + length);
        offset += length;
        return binaryData;
      }
      
      case TYPE.ARRAY: {
        if (offset + 4 > data.length) {
          throw new Error('Unexpected end of data for ARRAY size');
        }
        // Read size in bytes
        const sizeView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const size = sizeView.getUint32(0, true);
        offset += 4;
        
        if (offset + size > data.length) {
          throw new Error('Unexpected end of data for ARRAY content');
        }
        
        // Read array length
        const lengthView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const length = lengthView.getUint32(0, true);
        offset += 4;
        
        const arr = [];
        for (let i = 0; i < length; i++) {
          arr.push(decodeValue());
        }
        return arr;
      }
      
      case TYPE.OBJECT: {
        if (offset + 4 > data.length) {
          throw new Error('Unexpected end of data for OBJECT size');
        }
        // Read size in bytes
        const sizeView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const size = sizeView.getUint32(0, true);
        offset += 4;
        
        if (offset + size > data.length) {
          throw new Error('Unexpected end of data for OBJECT content');
        }
        
        // Read number of keys
        const lengthView = new DataView(data.buffer, data.byteOffset + offset, 4);
        const length = lengthView.getUint32(0, true);
        offset += 4;
        
        const obj = {};
        for (let i = 0; i < length; i++) {
          // Decode key
          if (offset + 4 > data.length) {
            throw new Error('Unexpected end of data for OBJECT key length');
          }
          const keyLengthView = new DataView(data.buffer, data.byteOffset + offset, 4);
          const keyLength = keyLengthView.getUint32(0, true);
          offset += 4;
          
          if (offset + keyLength > data.length) {
            throw new Error('Unexpected end of data for OBJECT key');
          }
          const keyData = data.slice(offset, offset + keyLength);
          offset += keyLength;
          const key = new TextDecoder().decode(keyData);
          
          // Decode value
          obj[key] = decodeValue();
        }
        return obj;
      }
      
      default:
        throw new Error(`Unknown type byte: 0x${type.toString(16)}`);
    }
  }

  return decodeValue();
}

/**
 * OPFS File Operations using FileSystemSyncAccessHandle
 * 
 * IMPORTANT: This class wraps FileSystemSyncAccessHandle which is only available
 * in Web Workers. It provides synchronous file operations with explicit flush control.
 */
class BJsonFile {
  constructor(syncAccessHandle) {
    if (!syncAccessHandle) {
      throw new Error('FileSystemSyncAccessHandle is required');
    }
    this.syncAccessHandle = syncAccessHandle;
  }


  /**
   * Read a range of bytes from the file
   */
  #readRange(start, length) {
    const buffer = new Uint8Array(length);
    const bytesRead = this.syncAccessHandle.read(buffer, { at: start });
    if (bytesRead < length) {
      // Return only the bytes that were actually read
      return buffer.slice(0, bytesRead);
    }
    return buffer;
  }

  /**
   * Get the current file size
   */
  getFileSize() {
    return this.syncAccessHandle.getSize();
  }

  /**
   * Write data to file, truncating existing content
   * @param {*} data - Data to encode and write
   */
  write(data) {
    // Encode data to binary
    const binaryData = encode(data);
    
    // Truncate file to 0 bytes (clear existing content)
    this.syncAccessHandle.truncate(0);
    
    // Write data at beginning of file
    this.syncAccessHandle.write(binaryData, { at: 0 });
  }

  /**
   * Read and decode data from file starting at optional pointer offset
   * @param {Pointer} pointer - Optional offset to start reading from (default: 0)
   * @returns {*} - Decoded data
   */
  read(pointer = new Pointer(0)) {
    const fileSize = this.getFileSize();
    
    if (fileSize === 0) {
      throw new Error('File is empty');
    }

    const pointerValue = pointer.valueOf();
    
    // Validate pointer offset
    if (pointerValue < 0 || pointerValue >= fileSize) {
      throw new Error(`Pointer offset ${pointer} out of file bounds [0, ${fileSize})`);
    }
    
    // Read from pointer offset to end of file
    const binaryData = this.#readRange(pointerValue, fileSize - pointerValue);
    
    // Decode and return the first value
    return decode(binaryData);
  }

  /**
   * Append data to file without truncating existing content
   * @param {*} data - Data to encode and append
   */
  append(data) {
    // Encode new data to binary
    const binaryData = encode(data);
    
    // Get current file size
    const existingSize = this.getFileSize();
    
    // Write new data at end of file
    this.syncAccessHandle.write(binaryData, { at: existingSize });
  }

  /**
   * Explicitly flush any pending writes to disk
   */
  flush() {
    this.syncAccessHandle.flush();
  }

  /**
   * Generator to scan through all records in the file
   * Each record is decoded and yielded one at a time
   */
  *scan() {
    const fileSize = this.getFileSize();
      
      if (fileSize === 0) {
        return;
      }
      
      let offset = 0;
      
      // Scan through and yield each top-level value
      while (offset < fileSize) {
        // Helper function to determine how many bytes a value occupies
        const getValueSize = (readPosition) => {
          // Read 1 byte for type
          let tempData = this.#readRange(readPosition, 1);
          let pos = 1;
          const type = tempData[0];
          
          switch (type) {
            case TYPE.NULL:
            case TYPE.FALSE:
            case TYPE.TRUE:
              return 1;
            
            case TYPE.INT:
            case TYPE.FLOAT:
            case TYPE.DATE:
            case TYPE.POINTER:
              return 1 + 8;

            case TYPE.OID:
              return 1 + 12;
            
            case TYPE.STRING: {
              // Read length (4 bytes)
              tempData = this.#readRange(readPosition + 1, 4);
              const view = new DataView(tempData.buffer, tempData.byteOffset, 4);
              const length = view.getUint32(0, true);
              return 1 + 4 + length;
            }
            
            case TYPE.BINARY: {
              // Read length (4 bytes)
              tempData = this.#readRange(readPosition + 1, 4);
              const view = new DataView(tempData.buffer, tempData.byteOffset, 4);
              const length = view.getUint32(0, true);
              return 1 + 4 + length;
            }
            
            case TYPE.ARRAY: {
              // Read size in bytes (4 bytes)
              tempData = this.#readRange(readPosition + 1, 4);
              const view = new DataView(tempData.buffer, tempData.byteOffset, 4);
              const size = view.getUint32(0, true);
              return 1 + 4 + size; // type + size + content
            }
            
            case TYPE.OBJECT: {
              // Read size in bytes (4 bytes)
              tempData = this.#readRange(readPosition + 1, 4);
              const view = new DataView(tempData.buffer, tempData.byteOffset, 4);
              const size = view.getUint32(0, true);
              return 1 + 4 + size; // type + size + content
            }
            
            default:
              throw new Error(`Unknown type byte: 0x${type.toString(16)}`);
          }
        };
        
        // Determine size of the current value
        const valueSize = getValueSize(offset);
        
        // Read only the bytes needed for this value
        const valueData = this.#readRange(offset, valueSize);
        offset += valueSize;
        
        // Decode and yield this value
        yield decode(valueData);
      }
  }
}

/**
 * Check if a file exists in OPFS
 * @param {FileSystemFileHandle} fileHandle - The file handle to check
 * @returns {boolean} - True if file exists and is readable
 */
function exists(fileHandle) {
  try {
    // If we have a handle, the file exists
    return fileHandle !== null && fileHandle !== undefined;
  } catch {
    return false;
  }
}

/**
 * Delete a file from OPFS
 * @param {FileSystemDirectoryHandle} dirHandle - The directory handle
 * @param {string} filename - Name of the file to delete
 */
async function deleteFile(dirHandle, filename) {
  try {
    await dirHandle.removeEntry(filename);
  } catch (error) {
    if (error.name === 'NotFoundError') {
      // File doesn't exist, nothing to delete
      return;
    }
    throw error;
  }
}

/**
 * Get or create a file handle from a directory
 * @param {FileSystemDirectoryHandle} dirHandle - The directory handle
 * @param {string} filename - Name of the file
 * @param {Object} options - Options for getFileHandle
 * @returns {FileSystemFileHandle} - The file handle
 */
async function getFileHandle(dirHandle, filename, options = {}) {
  return dirHandle.getFileHandle(filename, options);
}

export {
  TYPE,
  ObjectId,
  Pointer,
  encode,
  decode,
  BJsonFile,
  exists,
  deleteFile,
  getFileHandle
};
