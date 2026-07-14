/**
 * Full end-to-end tests: a real MongoClient (client/) talking real HTTP to
 * a real REST gateway (service/rest-gateway.js) backed by a real
 * TenantWorker/LeaseStore/binjson engine -- nothing mocked at any layer.
 * This is the proof that the client shim (built in response to "can
 * clients just use axios?") actually closes the gaps raw axios usage
 * would hit: Extended JSON conversion and cursor pagination happen
 * invisibly to the calling code below, the same way they would for a real
 * consumer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { MemoryStorageProvider } from '../src/db.js';
import { openControlPlane } from '../service/control-plane.js';
import { TenantWorker } from '../service/tenant-worker.js';
import { createRestGateway } from '../service/rest-gateway.js';
import { attachWebSocketGateway } from '../service/websocket-gateway.js';
import { TokenBucketRateLimiter } from '../service/rate-limiter.js';
import { MongoClient, ObjectId, MongoServerError } from '../client/index.js';

/** These tests exercise request patterns, not rate limiting itself -- a generous default keeps them from tripping the production-sized limit. */
function unlimited() {
  return new TokenBucketRateLimiter({ capacity: 100_000, refillPerSec: 100_000 });
}

await ready();

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Polls a predicate on wall-clock time -- these tests exercise real WS/HTTP timing, not fake timers. */
async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A live gateway (REST + WebSocket, same server) + a provisioned tenant, ready for a real MongoClient to connect to. */
async function setup(gatewayOptions = {}, wsOptions = {}) {
  const controlPlane = await openControlPlane({ provider: new MemoryStorageProvider() });
  const { tenantId, apiKey } = await controlPlane.tenantRegistry.createTenant();
  await controlPlane.leaseStore.provisionTenant(tenantId);

  const tenantWorker = new TenantWorker({
    leaseStore: controlPlane.leaseStore,
    workerId: 'worker-a',
    createProvider: () => new MemoryStorageProvider(),
    ttlMs: 30_000
  });

  const server = createRestGateway({
    tenantWorker,
    tenantRegistry: controlPlane.tenantRegistry,
    requestRateLimiter: unlimited(),
    ...gatewayOptions
  });
  const { wss, onTenantClosing } = attachWebSocketGateway(server, {
    tenantWorker,
    tenantRegistry: controlPlane.tenantRegistry,
    heartbeatIntervalMs: 10_000, // quiet by default -- tests that care override explicitly
    ...wsOptions
  });
  tenantWorker.onTenantClosing = onTenantClosing;

  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  cleanups.push(async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await controlPlane.close();
  });

  return { baseUrl, apiKey, tenantId, controlPlane, server, tenantWorker };
}

describe('client end-to-end (real MongoClient -> real HTTP -> real gateway -> real engine)', () => {
  it('connect() succeeds with a valid key and fails with an invalid one', async () => {
    const { baseUrl, apiKey } = await setup();

    const client = new MongoClient(baseUrl, { apiKey });
    await expect(client.connect()).resolves.toBe(client);
    await client.close();

    const badClient = new MongoClient(baseUrl, { apiKey: 'sk_not-real' });
    await expect(badClient.connect()).rejects.toThrow(MongoServerError);
  });

  it('insertOne/findOne round-trip real ObjectId and Date instances, not wire wrapper objects', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const users = client.db('anything').collection('users');

    const joined = new Date('2024-01-01T00:00:00.000Z');
    const { insertedId } = await users.insertOne({ name: 'Ada', joined });
    expect(insertedId).toBeInstanceOf(ObjectId);

    const doc = await users.findOne({ _id: insertedId });
    expect(doc._id).toBeInstanceOf(ObjectId);
    expect(doc._id.equals(insertedId)).toBe(true);
    expect(doc.joined).toBeInstanceOf(Date);
    expect(doc.joined.toISOString()).toBe(joined.toISOString());

    await client.close();
  });

  it('findOne honors a projection', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const users = client.db('x').collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core', age: 36 });

    const thin = await users.findOne({ _id: insertedId }, { projection: { name: 1 } });
    expect(thin).toEqual({ _id: insertedId, name: 'Ada' });
    await client.close();
  });

  it('find() with sort/skip/limit/project chaining and toArray()', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const items = client.db('x').collection('items');
    for (const n of [5, 3, 1, 4, 2]) await items.insertOne({ n, noise: 'x'.repeat(10) });

    const page = await items.find({}).sort({ n: 1 }).skip(1).limit(2).project({ n: 1 }).toArray();
    expect(page).toEqual([{ _id: page[0]._id, n: 2 }, { _id: page[1]._id, n: 3 }]);
    await client.close();
  });

  it('find() streams 250 documents via for-await, spanning multiple HTTP pages and the real WASM cursor', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const items = client.db('x').collection('items');
    for (let i = 0; i < 250; i++) await items.insertOne({ n: i });

    const seen = [];
    for await (const doc of items.find({})) seen.push(doc.n);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    await client.close();
  });

  it('breaking out of a for-await loop early releases the server-side cursor', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const items = client.db('x').collection('items');
    for (let i = 0; i < 250; i++) await items.insertOne({ n: i });

    let cursorId;
    let count = 0;
    const cursor = items.find({});
    for await (const doc of cursor) {
      void doc;
      if (count === 0) cursorId = cursor._cursorId; // captured after the first page, before any break
      count++;
      if (count === 5) break;
    }
    expect(count).toBe(5);
    expect(cursorId).toBeTruthy();

    // The gateway's cursor registry no longer has it -- a raw fetch proves this independently of the client shim.
    const res = await fetch(`${baseUrl}/v1/cursors/${cursorId}/next`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(404);
    await client.close();
  });

  it('updateOne and deleteOne work', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const users = client.db('x').collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core' });

    const updateResult = await users.updateOne({ _id: insertedId }, { $set: { team: 'kernel' } });
    expect(updateResult).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect((await users.findOne({ _id: insertedId })).team).toBe('kernel');

    const deleteResult = await users.deleteOne({ _id: insertedId });
    expect(deleteResult).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await users.findOne({ _id: insertedId })).toBeNull();
    await client.close();
  });

  it('a duplicate _id throws MongoServerError with a real .code, matching real MongoDB driver usage', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const users = client.db('x').collection('users');
    const { insertedId } = await users.insertOne({ name: 'Ada' });

    let caught;
    try {
      await users.insertOne({ _id: insertedId, name: 'Impostor' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MongoServerError);
    expect(caught.code).toBe(11000);
    expect(caught.codeName).toBe('DuplicateKey');
    await client.close();
  });

  it('db.listCollections() and dropCollection()', async () => {
    const { baseUrl, apiKey } = await setup();
    const client = new MongoClient(baseUrl, { apiKey });
    const db = client.db('x');
    await db.collection('users').insertOne({ name: 'Ada' });

    expect(await db.listCollections()).toEqual(['users']);
    await db.dropCollection('users');
    expect(await db.listCollections()).toEqual([]);
    await client.close();
  });

  it(
    'a 503 while the tenant is briefly owned by another worker is retried transparently -- the caller never sees an error',
    async () => {
      const controlPlane = await openControlPlane({ provider: new MemoryStorageProvider() });
      const { tenantId, apiKey } = await controlPlane.tenantRegistry.createTenant();
      await controlPlane.leaseStore.provisionTenant(tenantId);

      const rival = new TenantWorker({
        leaseStore: controlPlane.leaseStore,
        workerId: 'worker-rival',
        createProvider: () => new MemoryStorageProvider(),
        ttlMs: 30_000
      });
      await rival.open(tenantId); // holds the lease so the gateway's own worker can't acquire it yet

      const tenantWorker = new TenantWorker({
        leaseStore: controlPlane.leaseStore,
        workerId: 'worker-a',
        createProvider: () => new MemoryStorageProvider(),
        ttlMs: 30_000
      });
      const server = createRestGateway({ tenantWorker, tenantRegistry: controlPlane.tenantRegistry, requestRateLimiter: unlimited() });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      // Releases the lease shortly after the client's first (failing) attempt --
      // well inside the gateway's hardcoded 1s Retry-After, so the client's
      // automatic retry lands after the tenant is free again.
      setTimeout(() => {
        rival.release(tenantId).catch(() => {});
      }, 200);

      const client = new MongoClient(baseUrl, { apiKey });
      const result = await client.db('x').listCollections(); // must resolve, not throw, despite the initial 503
      expect(result).toEqual([]);

      await client.close();
      await new Promise((resolve) => server.close(resolve));
      await tenantWorker.closeAll();
      await controlPlane.close();
    },
    5000
  );

  it(
    'a 429 from a low rate limit is retried transparently -- the caller never sees an error',
    async () => {
      const { baseUrl, apiKey } = await setup({
        requestRateLimiter: new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 1 })
      });
      const client = new MongoClient(baseUrl, { apiKey });

      // Burns through the 2-token burst capacity; the 3rd call hits 429 and
      // the shim's own retry (honoring Retry-After) must absorb it silently.
      await client.db('x').listCollections();
      await client.db('x').listCollections();
      const result = await client.db('x').listCollections();
      expect(result).toEqual([]);

      await client.close();
    },
    5000
  );

  describe('watch() over the WebSocket gateway', () => {
    it('delivers a real change event via for-await', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');

      const stream = items.watch();
      const iterator = (async () => {
        for await (const change of stream) return change;
      })();

      await waitUntil(() => client._wsSubscriptions.size === 1); // subscribe ack landed before inserting
      const { insertedId } = await items.insertOne({ name: 'Ada' });

      const change = await iterator;
      expect(change.operationType).toBe('insert');
      expect(change.ns).toEqual({ coll: 'items' });
      expect(change.documentKey._id.equals(insertedId)).toBe(true);
      expect(change.fullDocument.name).toBe('Ada');

      await client.close();
    });

    it('delivers change events via on(\'change\', cb) too, and multiple inserts arrive in order', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');

      const stream = items.watch();
      const received = [];
      stream.on('change', (change) => received.push(change.fullDocument.n));

      await waitUntil(() => client._wsSubscriptions.size === 1);
      await items.insertOne({ n: 1 });
      await items.insertOne({ n: 2 });
      await items.insertOne({ n: 3 });

      await waitUntil(() => received.length === 3);
      expect(received).toEqual([1, 2, 3]);

      stream.close();
      await client.close();
    });

    it('stream.close() unsubscribes -- no further events arrive after it', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');

      const stream = items.watch();
      const received = [];
      stream.on('change', (change) => received.push(change));
      await waitUntil(() => client._wsSubscriptions.size === 1);

      await items.insertOne({ n: 1 });
      await waitUntil(() => received.length === 1);

      stream.close();
      await waitUntil(() => client._wsSubscriptions.size === 0);

      await items.insertOne({ n: 2 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toHaveLength(1); // still just the one from before close()

      await client.close();
    });

    it('two collections can be watched independently over the one multiplexed connection', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const db = client.db('x');
      const items = db.collection('items');
      const users = db.collection('users');

      const itemChanges = [];
      const userChanges = [];
      items.watch().on('change', (c) => itemChanges.push(c));
      users.watch().on('change', (c) => userChanges.push(c));
      await waitUntil(() => client._wsSubscriptions.size === 2);

      await items.insertOne({ n: 1 });
      await waitUntil(() => itemChanges.length === 1);
      expect(userChanges).toHaveLength(0); // items' insert must not leak to users' subscription

      await users.insertOne({ name: 'Ada' });
      await waitUntil(() => userChanges.length === 1);
      expect(itemChanges).toHaveLength(1); // unchanged

      await client.close();
    });

    it('an unexpected disconnect reconnects and re-subscribes automatically -- the caller sees no gap to handle', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');

      const received = [];
      items.watch().on('change', (c) => received.push(c.fullDocument.name));
      await waitUntil(() => client._wsSubscriptions.size === 1);

      await items.insertOne({ name: 'before-drop' });
      await waitUntil(() => received.length === 1);

      // Not a normal (1000) close -- simulates a network drop the shim didn't initiate.
      client._ws.close(4000, 'simulated drop');
      await waitUntil(() => client._ws && client._ws.readyState === WebSocket.OPEN, { timeoutMs: 5000 });
      await waitUntil(() => client._wsSubscriptions.size === 1, { timeoutMs: 5000 }); // resubscribed

      await items.insertOne({ name: 'after-reconnect' });
      await waitUntil(() => received.length === 2, { timeoutMs: 3000 });

      expect(received).toEqual(['before-drop', 'after-reconnect']);
      await client.close();
    });

    it('watch() throws for a non-empty pipeline (not yet supported), matching the embedded API', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');
      expect(() => items.watch([{ $match: {} }])).toThrow(/pipeline/);
      await client.close();
    });

    it('client.close() closes the underlying WebSocket connection', async () => {
      const { baseUrl, apiKey } = await setup();
      const client = new MongoClient(baseUrl, { apiKey });
      const items = client.db('x').collection('items');

      items.watch();
      await waitUntil(() => client._ws && client._ws.readyState === WebSocket.OPEN);

      await client.close();
      await waitUntil(() => client._ws === null || client._ws.readyState === WebSocket.CLOSED);
    });
  });
});
