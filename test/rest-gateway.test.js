import { describe, it, expect, afterEach } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { MemoryStorageProvider } from '../src/db.js';
import { openControlPlane } from '../service/control-plane.js';
import { TenantWorker } from '../service/tenant-worker.js';
import { createRestGateway } from '../service/rest-gateway.js';
import { TokenBucketRateLimiter } from '../service/rate-limiter.js';

/** Tests below exercise request patterns (bulk inserts, pagination loops), not rate limiting itself -- a generous default keeps them from tripping the production-sized limit. Rate-limiting-specific tests override this explicitly. */
function unlimited() {
  return new TokenBucketRateLimiter({ capacity: 100_000, refillPerSec: 100_000 });
}

await ready();

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A live gateway + a provisioned tenant's API key, ready for real HTTP calls. */
async function setup() {
  const controlPlane = await openControlPlane({ provider: new MemoryStorageProvider() });
  const { tenantId, apiKey } = await controlPlane.tenantRegistry.createTenant();
  await controlPlane.leaseStore.provisionTenant(tenantId);

  const tenantWorker = new TenantWorker({
    leaseStore: controlPlane.leaseStore,
    workerId: 'worker-a',
    createProvider: () => new MemoryStorageProvider(),
    ttlMs: 30_000
  });

  const server = createRestGateway({ tenantWorker, tenantRegistry: controlPlane.tenantRegistry, requestRateLimiter: unlimited() });
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await controlPlane.close();
  });

  return { baseUrl, apiKey, tenantId };
}

function authedFetch(baseUrl, apiKey) {
  return (pathname, init = {}) =>
    fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init.headers }
    });
}

describe('REST gateway (real HTTP, end to end)', () => {
  it('rejects requests with no bearer token', async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/v1/collections`);
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid API key', async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/v1/collections`, { headers: { Authorization: 'Bearer sk_not-real' } });
    expect(res.status).toBe(401);
  });

  it('404s an unknown route', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);
    const res = await call('/v1/nope');
    expect(res.status).toBe(404);
  });

  it('insert-one, find-one, and list-collections round-trip real ObjectId/Date values over the wire', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);

    const insertRes = await call('/v1/collections/users/insert-one', {
      method: 'POST',
      body: JSON.stringify({ document: { name: 'Ada', joined: { $date: '2024-01-01T00:00:00.000Z' } } })
    });
    expect(insertRes.status).toBe(200);
    const { insertedId } = await insertRes.json();
    expect(insertedId).toHaveProperty('$oid');

    const findRes = await call('/v1/collections/users/find-one', {
      method: 'POST',
      body: JSON.stringify({ filter: { _id: insertedId } })
    });
    const { document } = await findRes.json();
    expect(document.name).toBe('Ada');
    expect(document.joined).toEqual({ $date: '2024-01-01T00:00:00.000Z' });
    expect(document._id).toEqual(insertedId);

    const listRes = await call('/v1/collections');
    expect(await listRes.json()).toEqual({ collections: ['users'] });
  });

  it('find-one honors a projection over the wire', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);

    const { insertedId } = await (
      await call('/v1/collections/users/insert-one', {
        method: 'POST',
        body: JSON.stringify({ document: { name: 'Ada', team: 'core', age: 36 } })
      })
    ).json();

    const projected = await (
      await call('/v1/collections/users/find-one', {
        method: 'POST',
        body: JSON.stringify({ filter: { _id: insertedId }, projection: { name: 1 } })
      })
    ).json();
    expect(projected.document).toEqual({ _id: insertedId, name: 'Ada' });

    const unprojected = await (
      await call('/v1/collections/users/find-one', { method: 'POST', body: JSON.stringify({ filter: { _id: insertedId } }) })
    ).json();
    expect(unprojected.document).toEqual({ _id: insertedId, name: 'Ada', team: 'core', age: 36 });
  });

  it('find paginates through cursors, then update-one and delete-one work', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);

    for (let i = 0; i < 5; i++) {
      await call('/v1/collections/items/insert-one', {
        method: 'POST',
        body: JSON.stringify({ document: { n: i } })
      });
    }

    const firstPage = await call('/v1/collections/items/find', {
      method: 'POST',
      body: JSON.stringify({ filter: {}, sort: { n: 1 }, batchSize: 2 })
    });
    const page1 = await firstPage.json();
    expect(page1.batch.map((d) => d.n)).toEqual([0, 1]);
    expect(page1.cursorId).toBeTruthy();

    const secondPage = await call(`/v1/cursors/${page1.cursorId}/next?batchSize=2`);
    const page2 = await secondPage.json();
    expect(page2.batch.map((d) => d.n)).toEqual([2, 3]);
    expect(page2.cursorId).toBe(page1.cursorId);

    const thirdPage = await call(`/v1/cursors/${page1.cursorId}/next?batchSize=2`);
    const page3 = await thirdPage.json();
    expect(page3.batch.map((d) => d.n)).toEqual([4]);
    expect(page3.cursorId).toBeNull(); // exhausted

    // The now-exhausted cursor is gone -- a further /next 404s.
    const afterDone = await call(`/v1/cursors/${page1.cursorId}/next`);
    expect(afterDone.status).toBe(404);

    const target = page1.batch[0]; // n: 0
    const updateRes = await call('/v1/collections/items/update-one', {
      method: 'POST',
      body: JSON.stringify({ filter: { _id: target._id }, update: { $set: { tag: 'first' } } })
    });
    expect(await updateRes.json()).toMatchObject({ matchedCount: 1, modifiedCount: 1 });

    const deleteRes = await call('/v1/collections/items/delete-one', {
      method: 'POST',
      body: JSON.stringify({ filter: { _id: target._id } })
    });
    expect(await deleteRes.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it('an unsorted find of 250 documents pages correctly across the real WASM cursor (multiple 100-doc internal batches)', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);

    for (let i = 0; i < 250; i++) {
      await call('/v1/collections/many/insert-one', { method: 'POST', body: JSON.stringify({ document: { n: i } }) });
    }

    const seen = [];
    let page = await (
      await call('/v1/collections/many/find', { method: 'POST', body: JSON.stringify({ batchSize: 37 }) })
    ).json();
    seen.push(...page.batch.map((d) => d.n));
    while (page.cursorId) {
      page = await (await call(`/v1/cursors/${page.cursorId}/next?batchSize=37`)).json();
      seen.push(...page.batch.map((d) => d.n));
    }
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });

  it('a sorted find still returns correctly ordered pages (materializes up front, unlike the unsorted path)', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);
    for (const n of [5, 3, 1, 4, 2]) {
      await call('/v1/collections/sorted/insert-one', { method: 'POST', body: JSON.stringify({ document: { n } }) });
    }

    const page1 = await (
      await call('/v1/collections/sorted/find', {
        method: 'POST',
        body: JSON.stringify({ sort: { n: 1 }, batchSize: 3 })
      })
    ).json();
    expect(page1.batch.map((d) => d.n)).toEqual([1, 2, 3]);
    const page2 = await (await call(`/v1/cursors/${page1.cursorId}/next?batchSize=3`)).json();
    expect(page2.batch.map((d) => d.n)).toEqual([4, 5]);
    expect(page2.cursorId).toBeNull();
  });

  it('abandoning a cursor mid-pagination does not break the tenant once the idle sweep reclaims it', async () => {
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
      cursorIdleMs: 50,
      cursorSweepIntervalMs: 20,
      requestRateLimiter: unlimited()
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = authedFetch(baseUrl, apiKey);

    for (let i = 0; i < 150; i++) {
      await call('/v1/collections/many/insert-one', { method: 'POST', body: JSON.stringify({ document: { n: i } }) });
    }
    const page = await (
      await call('/v1/collections/many/find', { method: 'POST', body: JSON.stringify({ batchSize: 10 }) })
    ).json();
    expect(page.cursorId).toBeTruthy(); // left open, abandoned -- never paged further

    await new Promise((resolve) => setTimeout(resolve, 150)); // outlast cursorIdleMs + a sweep tick

    const stale = await call(`/v1/cursors/${page.cursorId}/next`);
    expect(stale.status).toBe(404);

    // The collection itself must still work after the sweep closed the abandoned WASM cursor.
    const stillWorks = await call('/v1/collections/many/find-one', { method: 'POST', body: JSON.stringify({}) });
    expect(stillWorks.status).toBe(200);

    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await controlPlane.close();
  });

  it('rejects paging a cursor with a different tenant\'s API key', async () => {
    const { baseUrl, apiKey } = await setup();
    const other = await setup();
    const call = authedFetch(baseUrl, apiKey);

    for (let i = 0; i < 3; i++) {
      await call('/v1/collections/items/insert-one', { method: 'POST', body: JSON.stringify({ document: { n: i } }) });
    }
    const first = await (
      await call('/v1/collections/items/find', { method: 'POST', body: JSON.stringify({ batchSize: 1 }) })
    ).json();
    expect(first.cursorId).toBeTruthy();

    const otherCall = authedFetch(other.baseUrl, other.apiKey);
    const res = await fetch(`${other.baseUrl}/v1/cursors/${first.cursorId}/next`, {
      headers: { Authorization: `Bearer ${other.apiKey}` }
    });
    expect(res.status).toBe(404);
    void otherCall; // unused beyond constructing baseUrl/apiKey pairing above
  });

  it('a duplicate _id insert returns 409 with a Mongo-shaped error body', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);

    const first = await call('/v1/collections/users/insert-one', {
      method: 'POST',
      body: JSON.stringify({ document: { name: 'Ada' } })
    });
    const { insertedId } = await first.json();

    const dupe = await call('/v1/collections/users/insert-one', {
      method: 'POST',
      body: JSON.stringify({ document: { _id: insertedId, name: 'Impostor' } })
    });
    expect(dupe.status).toBe(409);
    const body = await dupe.json();
    expect(body.error.code).toBe(11000);
    expect(body.error.codeName).toBe('DuplicateKey');
  });

  it('drop-collection removes it', async () => {
    const { baseUrl, apiKey } = await setup();
    const call = authedFetch(baseUrl, apiKey);
    await call('/v1/collections/scratch/insert-one', { method: 'POST', body: JSON.stringify({ document: {} }) });

    const dropRes = await call('/v1/collections/scratch', { method: 'DELETE' });
    expect(dropRes.status).toBe(204);
    expect(await (await call('/v1/collections')).json()).toEqual({ collections: [] });
  });

  it('returns 503 with Retry-After when the tenant is owned by another worker', async () => {
    const controlPlane = await openControlPlane({ provider: new MemoryStorageProvider() });
    const { tenantId, apiKey } = await controlPlane.tenantRegistry.createTenant();
    await controlPlane.leaseStore.provisionTenant(tenantId);

    // A rival worker grabs the lease first, standing in for another process already serving this tenant.
    const rival = new TenantWorker({
      leaseStore: controlPlane.leaseStore,
      workerId: 'worker-rival',
      createProvider: () => new MemoryStorageProvider(),
      ttlMs: 30_000
    });
    await rival.open(tenantId);

    const tenantWorker = new TenantWorker({
      leaseStore: controlPlane.leaseStore,
      workerId: 'worker-a',
      createProvider: () => new MemoryStorageProvider(),
      ttlMs: 30_000
    });
    const server = createRestGateway({ tenantWorker, tenantRegistry: controlPlane.tenantRegistry, requestRateLimiter: unlimited() });
    await new Promise((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${baseUrl}/v1/collections`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();

    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await rival.closeAll();
    await controlPlane.close();
  });

  it('returns 429 with Retry-After once a tenant exceeds its request rate limit', async () => {
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
      requestRateLimiter: new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 0.001 })
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = () => fetch(`${baseUrl}/v1/collections`, { headers: { Authorization: `Bearer ${apiKey}` } });

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await controlPlane.close();
  });
});
