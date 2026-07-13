/**
 * Milestone 1 of the document-database plan: catalog + collection
 * primitives (insertOne/findOne/find/deleteOne/replaceOne/countDocuments)
 * on top of the persistent B+ tree, no secondary indexes yet.
 */
import { describe, it, expect } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { ObjectId } from '../src/binjson.js';
import { connect, MemoryStorageProvider, OPFSStorageProvider } from '../src/db.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();

describe('db: catalog + collection primitives', () => {
  async function openDb() {
    return connect(new MemoryStorageProvider());
  }

  it('creates a collection on first access and lists it in the catalog', async () => {
    const db = await openDb();
    expect(await db.listCollections()).toEqual([]);
    const users = await db.collection('users');
    expect(users.name).toBe('users');
    expect(await db.listCollections()).toEqual(['users']);
    // Same name returns the same cached collection instance.
    expect(await db.collection('users')).toBe(users);
    await db.close();
  });

  it('insertOne assigns an ObjectId _id when none is given', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const { acknowledged, insertedId } = await users.insertOne({ name: 'Ada' });
    expect(acknowledged).toBe(true);
    expect(insertedId).toBeInstanceOf(ObjectId);

    const doc = await users.findOne({ _id: insertedId });
    expect(doc.name).toBe('Ada');
    expect(doc._id.equals(insertedId)).toBe(true);
    await db.close();
  });

  it('insertOne accepts a caller-supplied _id (ObjectId or hex string)', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const id = new ObjectId();
    await users.insertOne({ _id: id, name: 'Grace' });
    expect((await users.findOne({ _id: id })).name).toBe('Grace');
    await db.close();
  });

  it('findOne by _id requires an ObjectId, not a raw hex string (matches real MongoDB)', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const id = new ObjectId();
    await users.insertOne({ _id: id, name: 'Grace' });
    // A plain string _id does not auto-coerce to ObjectId in a filter, same
    // as the real driver: {_id: "<hex>"} and {_id: ObjectId("<hex>")} are
    // different BSON types and do not match each other.
    expect(await users.findOne({ _id: id.toHexString() })).toBeNull();
    await db.close();
  });

  it('insertOne rejects a duplicate _id', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const id = new ObjectId();
    await users.insertOne({ _id: id, name: 'Ada' });
    await expect(users.insertOne({ _id: id, name: 'Impostor' })).rejects.toThrow(/Duplicate _id/);
    await db.close();
  });

  it('findOne returns null when nothing matches', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    expect(await users.findOne({ _id: new ObjectId() })).toBeNull();
    expect(await users.findOne({ name: 'Nobody' })).toBeNull();
    await db.close();
  });

  it('findOne and find scan by non-_id field equality', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'Grace', team: 'core' });
    await users.insertOne({ name: 'Linus', team: 'kernel' });

    expect((await users.findOne({ name: 'Grace' })).team).toBe('core');

    const core = await users.find({ team: 'core' }).toArray();
    expect(core.map(d => d.name).sort()).toEqual(['Ada', 'Grace']);

    const all = await users.find({}).toArray();
    expect(all.length).toBe(3);

    const names = [];
    for await (const doc of users.find({ team: 'kernel' })) names.push(doc.name);
    expect(names).toEqual(['Linus']);
    await db.close();
  });

  it('matches nested-document and array fields by exact value equality', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', address: { city: 'London', zip: 'W1' }, tags: ['core', 'admin'] });
    await users.insertOne({ name: 'Grace', address: { city: 'Arlington', zip: '22201' }, tags: ['core'] });

    expect((await users.findOne({ address: { city: 'London', zip: 'W1' } })).name).toBe('Ada');
    expect((await users.findOne({ tags: ['core', 'admin'] })).name).toBe('Ada');
    // Real MongoDB embedded-document equality is field-order sensitive.
    expect(await users.findOne({ address: { zip: 'W1', city: 'London' } })).toBeNull();
    // A filter array is matched as a whole value, not as "contains".
    expect(await users.findOne({ tags: ['core'] })).not.toBeNull();
    expect((await users.findOne({ tags: ['core'] })).name).toBe('Grace');
    await db.close();
  });

  it('deleteOne removes by _id and reports deletedCount', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada' });

    expect(await users.deleteOne({ _id: new ObjectId() })).toEqual({ acknowledged: true, deletedCount: 0 });
    expect(await users.deleteOne({ _id: insertedId })).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await users.findOne({ _id: insertedId })).toBeNull();
    await db.close();
  });

  it('deleteOne removes the first match for a non-_id filter', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'Grace', team: 'core' });

    const { deletedCount } = await users.deleteOne({ team: 'core' });
    expect(deletedCount).toBe(1);
    expect(await users.countDocuments({ team: 'core' })).toBe(1);
    await db.close();
  });

  it('replaceOne replaces document content but preserves _id', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core' });

    const result = await users.replaceOne({ _id: insertedId }, { name: 'Ada Lovelace' });
    expect(result).toEqual({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null });

    const doc = await users.findOne({ _id: insertedId });
    expect(doc).toEqual({ _id: insertedId, name: 'Ada Lovelace' });
    await db.close();
  });

  it('replaceOne with no match and upsert:false is a no-op', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const result = await users.replaceOne({ name: 'Ghost' }, { name: 'Still a ghost' });
    expect(result).toEqual({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null });
    expect(await users.countDocuments()).toBe(0);
    await db.close();
  });

  it('replaceOne with upsert:true inserts a new document', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const result = await users.replaceOne({ name: 'Ghost' }, { name: 'Materialized' }, { upsert: true });
    expect(result.matchedCount).toBe(0);
    expect(result.upsertedId).toBeInstanceOf(ObjectId);

    const doc = await users.findOne({ _id: result.upsertedId });
    expect(doc.name).toBe('Materialized');
    await db.close();
  });

  it('replaceOne rejects changing _id on an existing document', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada' });
    await expect(
      users.replaceOne({ _id: insertedId }, { _id: new ObjectId(), name: 'Someone else' })
    ).rejects.toThrow(/cannot change the _id/);
    await db.close();
  });

  it('countDocuments counts the whole collection or a filtered subset', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'Grace', team: 'core' });
    await users.insertOne({ name: 'Linus', team: 'kernel' });

    expect(await users.countDocuments()).toBe(3);
    expect(await users.countDocuments({ team: 'core' })).toBe(2);
    expect(await users.countDocuments({ team: 'nope' })).toBe(0);
    await db.close();
  });

  it('keeps collections independent of one another', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const posts = await db.collection('posts');
    await users.insertOne({ name: 'Ada' });
    await posts.insertOne({ title: 'Hello world' });

    expect(await users.countDocuments()).toBe(1);
    expect(await posts.countDocuments()).toBe(1);
    expect(await db.listCollections()).toEqual(['posts', 'users']);
    await db.close();
  });

  it('dropCollection removes the collection; recreating it starts empty', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada' });

    expect(await db.dropCollection('users')).toBe(true);
    expect(await db.dropCollection('users')).toBe(false);
    expect(await db.listCollections()).toEqual([]);

    const fresh = await db.collection('users');
    expect(await fresh.countDocuments()).toBe(0);
    await db.close();
  });

  it('rejects invalid collection names', async () => {
    const db = await openDb();
    await expect(db.collection('a/b')).rejects.toThrow(/Invalid collection name/);
    await expect(db.collection('')).rejects.toThrow(/Invalid collection name/);
    await db.close();
  });

  it('persists data across close/reopen on the same provider', async () => {
    const provider = new MemoryStorageProvider();
    const db1 = await connect(provider);
    const id = new ObjectId();
    await (await db1.collection('users')).insertOne({ _id: id, name: 'Ada' });
    await db1.close();

    const db2 = await connect(provider);
    const users = await db2.collection('users');
    expect((await users.findOne({ _id: id })).name).toBe('Ada');
    await db2.close();
  });
});

describe('db: secondary indexes (milestone 2)', () => {
  async function openDb() {
    return connect(new MemoryStorageProvider());
  }

  it('createIndex on an empty collection and listIndexes reflects it', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    const name = await users.createIndex({ team: 1 });
    expect(name).toBe('team_1');
    expect(await users.listIndexes()).toEqual([{ name: 'team_1', key: { team: 1 } }]);
    await db.close();
  });

  it('createIndex backfills existing documents', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'Grace', team: 'core' });
    await users.insertOne({ name: 'Linus', team: 'kernel' });

    await users.createIndex({ team: 1 });
    const core = await users.findByIndex('team_1', ['core']);
    expect(core.map(d => d.name).sort()).toEqual(['Ada', 'Grace']);
    const kernel = await users.findByIndex('team_1', ['kernel']);
    expect(kernel.map(d => d.name)).toEqual(['Linus']);
    const none = await users.findByIndex('team_1', ['nope']);
    expect(none).toEqual([]);
    await db.close();
  });

  it('insertOne maintains an existing index', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'Linus', team: 'kernel' });

    expect((await users.findByIndex('team_1', ['core'])).map(d => d.name)).toEqual(['Ada']);
    expect((await users.findByIndex('team_1', ['kernel'])).map(d => d.name)).toEqual(['Linus']);
    await db.close();
  });

  it('deleteOne removes the document from every index', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core' });

    await users.deleteOne({ _id: insertedId });
    expect(await users.findByIndex('team_1', ['core'])).toEqual([]);
    await db.close();
  });

  it('replaceOne re-indexes when the indexed field changes', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core' });

    await users.replaceOne({ _id: insertedId }, { name: 'Ada', team: 'kernel' });
    expect(await users.findByIndex('team_1', ['core'])).toEqual([]);
    expect((await users.findByIndex('team_1', ['kernel'])).map(d => d.name)).toEqual(['Ada']);
    await db.close();
  });

  it('replaceOne upsert builds the index entry for the new document', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    await users.replaceOne({ name: 'Ghost' }, { name: 'Ghost', team: 'core' }, { upsert: true });

    expect((await users.findByIndex('team_1', ['core'])).map(d => d.name)).toEqual(['Ghost']);
    await db.close();
  });

  it('supports a compound (multi-field) index', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1, level: 1 });
    await users.insertOne({ name: 'Ada', team: 'core', level: 1 });
    await users.insertOne({ name: 'Grace', team: 'core', level: 2 });
    await users.insertOne({ name: 'Linus', team: 'kernel', level: 1 });

    expect((await users.findByIndex('team_1_level_1', ['core', 1])).map(d => d.name)).toEqual(['Ada']);
    expect((await users.findByIndex('team_1_level_1', ['core', 2])).map(d => d.name)).toEqual(['Grace']);
    expect(await users.findByIndex('team_1_level_1', ['kernel', 2])).toEqual([]);
    await db.close();
  });

  it('createIndex fails all-or-nothing when a document lacks the field', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.insertOne({ name: 'Ada', team: 'core' });
    await users.insertOne({ name: 'NoTeam' }); // missing `team`

    await expect(users.createIndex({ team: 1 })).rejects.toThrow();
    expect(await users.listIndexes()).toEqual([]);
    // The collection itself must still be fully usable after the failed attempt.
    expect(await users.countDocuments()).toBe(2);
    await db.close();
  });

  it('dropIndex removes it; findByIndex then reports it missing', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    await users.insertOne({ name: 'Ada', team: 'core' });

    await users.dropIndex('team_1');
    expect(await users.listIndexes()).toEqual([]);
    await expect(users.findByIndex('team_1', ['core'])).rejects.toThrow(/Index not found/);
    // Dropping the index must not touch the documents.
    expect(await users.countDocuments()).toBe(1);
    await db.close();
  });

  it('rejects a duplicate index name', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    await expect(users.createIndex({ team: 1 })).rejects.toThrow(/already exists/);
    await db.close();
  });

  it('rejects unique and descending index options as not yet supported', async () => {
    const db = await openDb();
    const users = await db.collection('users');
    await expect(users.createIndex({ team: 1 }, { unique: true })).rejects.toThrow(/unique/);
    await expect(users.createIndex({ team: -1 })).rejects.toThrow(/ascending/);
    await db.close();
  });

  it('indexes persist and stay maintained across close/reopen', async () => {
    const provider = new MemoryStorageProvider();
    const db1 = await connect(provider);
    const users1 = await db1.collection('users');
    await users1.createIndex({ team: 1 });
    await users1.insertOne({ name: 'Ada', team: 'core' });
    await db1.close();

    const db2 = await connect(provider);
    const users2 = await db2.collection('users');
    expect(await users2.listIndexes()).toEqual([{ name: 'team_1', key: { team: 1 } }]);
    expect((await users2.findByIndex('team_1', ['core'])).map(d => d.name)).toEqual(['Ada']);

    // Reopening must not re-run the backfill: insert a second core-team doc
    // and confirm the index sees exactly the two real documents, not
    // duplicated entries from a redundant backfill.
    await users2.insertOne({ name: 'Grace', team: 'core' });
    expect((await users2.findByIndex('team_1', ['core'])).map(d => d.name).sort()).toEqual(['Ada', 'Grace']);
    await db2.close();
  });
});

const { hasOPFS } = await bootstrapOPFS();

describe.skipIf(!hasOPFS)('db: OPFS storage provider', () => {
  it('round-trips insertOne/findOne through real OPFS files', async () => {
    const rootDirHandle = await navigator.storage.getDirectory();
    const dirName = `test-db-opfs-${Date.now()}`;
    const dbDir = await rootDirHandle.getDirectoryHandle(dirName, { create: true });

    const db = await connect(new OPFSStorageProvider(dbDir));
    const users = await db.collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada' });
    expect((await users.findOne({ _id: insertedId })).name).toBe('Ada');
    await db.close();

    const db2 = await connect(new OPFSStorageProvider(dbDir));
    const users2 = await db2.collection('users');
    expect((await users2.findOne({ _id: insertedId })).name).toBe('Ada');
    await db2.close();

    await rootDirHandle.removeEntry(dirName, { recursive: true });
  });
});
