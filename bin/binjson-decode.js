#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { decode, TYPE, ObjectId, Pointer } from '../src/binjson.js';

function usage() {
  console.error('Usage: binjson-decode <file.bj>');
  process.exit(1);
}

function getValueSize(data, start) {
  if (start >= data.length) {
    throw new Error(`Offset ${start} is outside the file bounds`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = data[start];

  switch (type) {
    case TYPE.NULL:
    case TYPE.FALSE:
    case TYPE.TRUE:
      return 1;
    case TYPE.INT:
      return 1 + 8;
    case TYPE.FLOAT:
      return 1 + 8;
    case TYPE.OID:
      return 1 + 12;
    case TYPE.DATE:
      return 1 + 8;
    case TYPE.POINTER:
      return 1 + 8;
    case TYPE.BINARY: {
      const length = view.getUint32(start + 1, true);
      return 1 + 4 + length;
    }
    case TYPE.STRING: {
      const length = view.getUint32(start + 1, true);
      return 1 + 4 + length;
    }
    case TYPE.ARRAY: {
      const size = view.getUint32(start + 1, true);
      return 1 + 4 + size;
    }
    case TYPE.OBJECT: {
      const size = view.getUint32(start + 1, true);
      return 1 + 4 + size;
    }
    default:
      throw new Error(`Unknown type byte 0x${type.toString(16)} at offset ${start}`);
  }
}

function formatValue(value) {
  const indentUnit = '  ';
  const render = (val, depth) => {
    const pad = indentUnit.repeat(depth);
    const nextPad = indentUnit.repeat(depth + 1);

    if (val === null) return 'null';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (typeof val === 'string') return JSON.stringify(val);

    if (val instanceof Pointer) {
      return `Pointer(${val.valueOf()})`;
    }

    if (val instanceof ObjectId) {
      return `ObjectId(${val.toHexString ? val.toHexString() : val.toString()})`;
    }

    if (val instanceof Date) {
      return `Date(${val.toISOString()})`;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const inner = val.map(item => `${nextPad}${render(item, depth + 1)}`).join('\n');
      return `[
${inner}
${pad}]`;
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val);
      if (entries.length === 0) return '{}';
      const inner = entries
        .map(([k, v]) => `${nextPad}${k}: ${render(v, depth + 1)}`)
        .join('\n');
      return `{
${inner}
${pad}}`;
    }

    return JSON.stringify(val);
  };

  return render(value, 0);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
  }

  const buffer = await readFile(filePath);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (data.length === 0) {
    console.log('File is empty.');
    return;
  }

  let offset = 0;
  let index = 0;

  while (offset < data.length) {
    const size = getValueSize(data, offset);
    const slice = data.slice(offset, offset + size);
    const value = decode(slice);

    console.log(`@ ${offset} (${size} bytes, entry: ${index})`);
    console.log(formatValue(value));

    offset += size;
    index += 1;
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
