#!/usr/bin/env node
import { ready } from '../src/binjson-wasm.js';
import { connect, OPFSStorageProvider } from '../src/db.js';
import { ObjectId, Pointer } from '../src/binjson.js';

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
  console.error(`Usage: db <name> <command> [args] [options]

A document database. <name> selects (creating if needed) an OPFS
subdirectory holding its catalog and collection/index files.

Database commands:
  collections                            List collection names (default)
  drop-collection <coll>                 Drop a collection and its indexes

Document commands:
  insert <coll> <doc>                    Insert one document
  find <coll> [filter]                   Find matching documents ({} if omitted)
  find-one <coll> [filter]               Find the first matching document
  count <coll> [filter]                  Count matching documents
  delete-one <coll> [filter]             Delete the first matching document
  replace-one <coll> <filter> <doc>      Replace the first matching document
  update-one <coll> <filter> <update>    Apply update operators to the first match
  update-many <coll> <filter> <update>   Apply update operators to every match

Index commands:
  create-index <coll> <keys>             e.g. create-index users '{"team":1}'
  drop-index <coll> <indexName>          Drop an index
  list-indexes <coll>                    List a collection's indexes
  find-by-index <coll> <indexName> <values>
                                          e.g. find-by-index users team_1 '["core"]'

<doc>/<filter>/<keys>/<values> are JSON. Query operators are plain JSON keys
(e.g. '{"age":{"$gt":30}}'); ObjectId and Date literals use MongoDB Extended
JSON: {"$oid":"<24 hex chars>"} and {"$date":"<ISO 8601>"}.

<update> for update-one/update-many is an object of $set/$unset/$inc/$push/
$pull operators, e.g. '{"$set":{"team":"core"},"$inc":{"visits":1}}'; a
plain replacement document is rejected -- use replace-one for that.

Options:
  --sort <json>       find: sort spec, e.g. '{"age":1}' or '{"age":-1}'
  --skip <n>          find: number of matches to skip
  --limit <n>         find: max matches to return
  --project <json>    find: projection spec, e.g. '{"name":1}' or '{"age":0}'
  --upsert            replace-one/update-one/update-many: insert if nothing matched
  --name <name>       create-index: index name (default: "field_1[_field2_1...]")
  --order <n>         B+ tree order for newly created files (default 32, min 3)
  -h, --help          Show this help`);
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

    if (val instanceof Pointer) return `Pointer(${val.valueOf()})`;
    if (val instanceof ObjectId) {
      return `ObjectId(${val.toHexString ? val.toHexString() : val.toString()})`;
    }
    if (val instanceof Date) return `Date(${val.toISOString()})`;

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const inner = val.map(item => `${nextPad}${render(item, depth + 1)}`).join('\n');
      return `[\n${inner}\n${pad}]`;
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val);
      if (entries.length === 0) return '{}';
      const inner = entries
        .map(([k, v]) => `${nextPad}${k}: ${render(v, depth + 1)}`)
        .join('\n');
      return `{\n${inner}\n${pad}}`;
    }

    return JSON.stringify(val);
  };

  return render(value, 0);
}

function printDocs(docs, noun = 'document') {
  if (docs.length === 0) {
    console.log(`No ${noun}s found.`);
    return;
  }
  for (let i = 0; i < docs.length; i++) {
    console.log(`${i}: ${formatValue(docs[i])}`);
  }
}

/** JSON.parse with MongoDB Extended JSON's {$oid} / {$date} literals. */
function parseJson(label, str) {
  try {
    return JSON.parse(str, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$oid' && typeof value.$oid === 'string') {
          return new ObjectId(value.$oid);
        }
        if (keys.length === 1 && keys[0] === '$date' && typeof value.$date === 'string') {
          return new Date(value.$date);
        }
      }
      return value;
    });
  } catch (err) {
    console.error(`Error: ${label} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const opts = { order: 32 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
    } else if (arg === '--upsert') {
      opts.upsert = true;
    } else if (arg === '--sort') {
      opts.sort = parseJson('--sort', argv[++i]);
    } else if (arg === '--project') {
      opts.project = parseJson('--project', argv[++i]);
    } else if (arg === '--skip') {
      opts.skip = Number(argv[++i]);
    } else if (arg === '--limit') {
      opts.limit = Number(argv[++i]);
    } else if (arg === '--name') {
      opts.name = argv[++i];
    } else if (arg === '--order') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 3) {
        console.error('Error: --order must be an integer >= 3');
        process.exit(1);
      }
      opts.order = n;
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function requireArgs(args, n, message) {
  if (args.length < n) {
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  const dbName = positional[0];
  if (!dbName) usage();

  const command = (positional[1] || 'collections').toLowerCase();
  const args = positional.slice(2);

  await ready();

  const rootDirHandle = await navigator.storage.getDirectory();
  const dbDirHandle = await rootDirHandle.getDirectoryHandle(dbName, { create: true });
  const db = await connect(new OPFSStorageProvider(dbDirHandle), { order: opts.order });

  try {
    switch (command) {
      case 'collections':
      case 'list': {
        const names = await db.listCollections();
        if (names.length === 0) {
          console.log('No collections.');
          break;
        }
        names.forEach((name, i) => console.log(`${i}: ${name}`));
        break;
      }

      case 'drop-collection': {
        requireArgs(args, 1, 'drop-collection requires <coll>');
        const dropped = await db.dropCollection(args[0]);
        if (dropped) {
          console.log(`Dropped collection ${args[0]}.`);
        } else {
          console.log(`Collection ${args[0]} does not exist; nothing dropped.`);
          process.exitCode = 1;
        }
        break;
      }

      case 'insert': {
        requireArgs(args, 2, 'insert requires <coll> and <doc>');
        const coll = await db.collection(args[0]);
        const doc = parseJson('<doc>', args[1]);
        const { insertedId } = await coll.insertOne(doc);
        console.log(`Inserted ${formatValue(insertedId)}.`);
        break;
      }

      case 'find': {
        requireArgs(args, 1, 'find requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const cursor = coll.find(filter, {
          sort: opts.sort,
          skip: opts.skip,
          limit: opts.limit,
          projection: opts.project
        });
        printDocs(await cursor.toArray());
        break;
      }

      case 'find-one': {
        requireArgs(args, 1, 'find-one requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const doc = await coll.findOne(filter);
        if (doc === null) {
          console.log('No document found.');
          process.exitCode = 1;
        } else {
          console.log(formatValue(doc));
        }
        break;
      }

      case 'count': {
        requireArgs(args, 1, 'count requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        console.log(String(await coll.countDocuments(filter)));
        break;
      }

      case 'delete-one': {
        requireArgs(args, 1, 'delete-one requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const { deletedCount } = await coll.deleteOne(filter);
        if (deletedCount) {
          console.log('Deleted 1 document.');
        } else {
          console.log('No document matched; nothing deleted.');
          process.exitCode = 1;
        }
        break;
      }

      case 'replace-one': {
        requireArgs(args, 3, 'replace-one requires <coll>, <filter>, and <doc>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const replacement = parseJson('<doc>', args[2]);
        const result = await coll.replaceOne(filter, replacement, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else if (result.modifiedCount) {
          console.log('Replaced 1 document.');
        } else {
          console.log('No document matched; nothing replaced.');
          process.exitCode = 1;
        }
        break;
      }

      case 'update-one': {
        requireArgs(args, 3, 'update-one requires <coll>, <filter>, and <update>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const update = parseJson('<update>', args[2]);
        const result = await coll.updateOne(filter, update, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else if (result.modifiedCount) {
          console.log('Updated 1 document.');
        } else {
          console.log('No document matched; nothing updated.');
          process.exitCode = 1;
        }
        break;
      }

      case 'update-many': {
        requireArgs(args, 3, 'update-many requires <coll>, <filter>, and <update>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const update = parseJson('<update>', args[2]);
        const result = await coll.updateMany(filter, update, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else {
          console.log(`Updated ${result.modifiedCount} document(s).`);
          if (result.modifiedCount === 0) process.exitCode = 1;
        }
        break;
      }

      case 'create-index': {
        requireArgs(args, 2, 'create-index requires <coll> and <keys>');
        const coll = await db.collection(args[0]);
        const keys = parseJson('<keys>', args[1]);
        const name = await coll.createIndex(keys, opts.name ? { name: opts.name } : {});
        console.log(`Created index ${name}.`);
        break;
      }

      case 'drop-index': {
        requireArgs(args, 2, 'drop-index requires <coll> and <indexName>');
        const coll = await db.collection(args[0]);
        await coll.dropIndex(args[1]);
        console.log(`Dropped index ${args[1]}.`);
        break;
      }

      case 'list-indexes': {
        requireArgs(args, 1, 'list-indexes requires <coll>');
        const coll = await db.collection(args[0]);
        const indexes = await coll.listIndexes();
        if (indexes.length === 0) {
          console.log('No indexes.');
          break;
        }
        indexes.forEach((ix, i) => console.log(`${i}: ${ix.name} ${formatValue(ix.key)}`));
        break;
      }

      case 'find-by-index': {
        requireArgs(args, 3, 'find-by-index requires <coll>, <indexName>, and <values>');
        const coll = await db.collection(args[0]);
        const values = parseJson('<values>', args[2]);
        printDocs(await coll.findByIndex(args[1], values));
        break;
      }

      default:
        console.error(`Error: unknown command '${command}'`);
        usage();
    }

    await db.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (db.isOpen) await db.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
