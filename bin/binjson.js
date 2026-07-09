#!/usr/bin/env node
import { ready, BinJsonFile, ObjectId, Pointer, getFileHandle } from '../src/binjson-wasm.js';

// Set up node-opfs for Node.js environment
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
  console.error('Error: node-opfs is required to run this tool in Node.js');
  console.error('Install it with: npm install node-opfs');
  process.exit(1);
}

function usage() {
  console.error(`Usage: binjson <file.bj> <command> [args] [options]

A binjson file is a flat sequence of top-level records. Records are addressed by
their position (index, starting at 0) or by their byte offset in the file.

Viewing:
  list                  Print every record with its byte offset and size (default)
  get <index>           Print a single record by its position
  read <offset>         Decode the record at a byte offset (a Pointer target)
  count                 Print the number of records
  info                  Print file size and record count

Editing:
  append <value>        Append a record to the end (creates the file if needed)
  write <value>         Replace the entire file with a single record
  set <index> <value>   Replace the record at <index> (rewrites the file)
  delete <index>        Remove the record at <index> (rewrites the file)

Values are parsed as JSON when possible (e.g. '{"a":1}', '[1,2]', '42', 'true',
'"text"'), and fall back to a raw string otherwise.

Options:
  -h, --help            Show this help

Note: set and delete rewrite the whole file, so any Pointer records that
reference byte offsets will no longer point at the same records afterwards.`);
  process.exit(1);
}

function formatValue(value) {
  const indentUnit = '  ';
  const render = (val, depth) => {
    const pad = indentUnit.repeat(depth);
    const nextPad = indentUnit.repeat(depth + 1);

    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
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

// Values are arbitrary binjson-encodable data. Accept JSON on the command line,
// falling back to the literal string when it is not valid JSON.
function parseValue(arg) {
  try {
    return JSON.parse(arg);
  } catch {
    return arg;
  }
}

function parseIndex(arg, label) {
  if (!/^\d+$/.test(arg)) {
    console.error(`Error: ${label} must be a non-negative integer`);
    process.exit(1);
  }
  return Number(arg);
}

// Decode every record into memory (used by the whole-file rewrite commands).
function collectValues(file) {
  const values = [];
  for (const { value } of file.scan()) values.push(value);
  return values;
}

// Replace the file contents with the given sequence of records.
function rewriteAll(syncHandle, file, values) {
  syncHandle.truncate(0);
  for (const value of values) file.append(value);
  syncHandle.flush();
}

async function main() {
  const argv = process.argv.slice(2).filter(a => {
    if (a === '-h' || a === '--help') usage();
    return true;
  });

  const filePath = argv[0];
  if (!filePath) usage();

  const command = (argv[1] || 'list').toLowerCase();
  const args = argv.slice(2);

  // Commands that create the file when missing; the rest require it to exist.
  const creating = command === 'append' || command === 'add' || command === 'write';

  await ready();

  let syncHandle;
  try {
    const rootDirHandle = await navigator.storage.getDirectory();
    const fileHandle = await getFileHandle(rootDirHandle, filePath, { create: creating });
    syncHandle = await fileHandle.createSyncAccessHandle();
    const file = new BinJsonFile(syncHandle);

    switch (command) {
      case 'list':
      case 'dump':
      case 'decode': {
        if (syncHandle.getSize() === 0) {
          console.log('File is empty.');
          break;
        }
        let index = 0;
        for (const { value, offset, size } of file.scan()) {
          console.log(`@ ${offset} (${size} bytes, entry: ${index})`);
          console.log(formatValue(value));
          index += 1;
        }
        break;
      }

      case 'get': {
        if (args.length < 1) {
          console.error('Error: get requires an <index>');
          process.exit(1);
        }
        const target = parseIndex(args[0], 'index');
        let index = 0;
        let found = false;
        for (const { value, offset, size } of file.scan()) {
          if (index === target) {
            console.log(`@ ${offset} (${size} bytes, entry: ${index})`);
            console.log(formatValue(value));
            found = true;
            break;
          }
          index += 1;
        }
        if (!found) {
          console.log(`No record at index ${target} (file has ${index} record${index === 1 ? '' : 's'}).`);
          process.exitCode = 1;
        }
        break;
      }

      case 'read': {
        if (args.length < 1) {
          console.error('Error: read requires a byte <offset>');
          process.exit(1);
        }
        const offset = parseIndex(args[0], 'offset');
        if (syncHandle.getSize() === 0) {
          console.log('File is empty.');
          process.exitCode = 1;
          break;
        }
        const value = file.read(new Pointer(offset));
        console.log(formatValue(value));
        break;
      }

      case 'count': {
        let index = 0;
        for (const _ of file.scan()) index += 1;
        console.log(index);
        break;
      }

      case 'info':
      case 'stats': {
        let index = 0;
        for (const _ of file.scan()) index += 1;
        console.log(`file:    ${filePath}`);
        console.log(`size:    ${syncHandle.getSize()} bytes`);
        console.log(`records: ${index}`);
        break;
      }

      case 'append':
      case 'add': {
        if (args.length < 1) {
          console.error('Error: append requires a <value>');
          process.exit(1);
        }
        const value = parseValue(args[0]);
        file.append(value);
        file.flush();
        console.log(`Appended ${formatValue(value)}`);
        break;
      }

      case 'write': {
        if (args.length < 1) {
          console.error('Error: write requires a <value>');
          process.exit(1);
        }
        const value = parseValue(args[0]);
        file.write(value);
        file.flush();
        console.log(`Wrote ${formatValue(value)} (file now holds 1 record).`);
        break;
      }

      case 'set':
      case 'replace': {
        if (args.length < 2) {
          console.error('Error: set requires an <index> and a <value>');
          process.exit(1);
        }
        const target = parseIndex(args[0], 'index');
        const value = parseValue(args[1]);
        const values = collectValues(file);
        if (target >= values.length) {
          console.error(`Error: no record at index ${target} (file has ${values.length} record${values.length === 1 ? '' : 's'})`);
          process.exit(1);
        }
        const previous = values[target];
        values[target] = value;
        rewriteAll(syncHandle, file, values);
        console.log(`Set record ${target}: ${formatValue(previous)} -> ${formatValue(value)}`);
        break;
      }

      case 'delete':
      case 'del':
      case 'remove': {
        if (args.length < 1) {
          console.error('Error: delete requires an <index>');
          process.exit(1);
        }
        const target = parseIndex(args[0], 'index');
        const values = collectValues(file);
        if (target >= values.length) {
          console.error(`Error: no record at index ${target} (file has ${values.length} record${values.length === 1 ? '' : 's'})`);
          process.exit(1);
        }
        const [removed] = values.splice(target, 1);
        rewriteAll(syncHandle, file, values);
        console.log(`Deleted record ${target}: ${formatValue(removed)}`);
        break;
      }

      default:
        console.error(`Error: unknown command '${command}'`);
        usage();
    }
  } finally {
    if (syncHandle) await syncHandle.close();
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
