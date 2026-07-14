import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { ObjectId } from '../src/binjson.js';
import { MemoryStorageProvider } from '../src/db.js';
import { LeaseStore } from '../service/lease-store.js';

await ready();

describe('LeaseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openStore() {
    return LeaseStore.open(new MemoryStorageProvider());
  }

  it('provisionTenant is idempotent', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);
    await store.provisionTenant(tenantId); // must not throw
    expect(await store.getLease(tenantId)).toEqual({
      _id: tenantId,
      workerId: null,
      leaseToken: null,
      expiresAt: null
    });
    await store.close();
  });

  it('acquire succeeds on an unheld lease and fails for a second worker while it is live', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);

    const grant = await store.acquire(tenantId, 'worker-a');
    expect(grant).not.toBeNull();
    expect(typeof grant.leaseToken).toBe('string');

    const rejected = await store.acquire(tenantId, 'worker-b');
    expect(rejected).toBeNull();

    const lease = await store.getLease(tenantId);
    expect(lease.workerId).toBe('worker-a');
    expect(lease.leaseToken).toBe(grant.leaseToken);
    await store.close();
  });

  it('renew extends the lease and keeps rejecting other workers', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);
    const grant = await store.acquire(tenantId, 'worker-a', 1000);

    vi.advanceTimersByTime(900); // not yet expired
    const renewed = await store.renew(tenantId, 'worker-a', grant.leaseToken, 1000);
    expect(renewed).toBeInstanceOf(Date);

    vi.advanceTimersByTime(900); // would have expired without the renewal
    expect(await store.acquire(tenantId, 'worker-b')).toBeNull();
    await store.close();
  });

  it('renew fails once the lease has expired and been reclaimed', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);
    const grant = await store.acquire(tenantId, 'worker-a', 1000);

    vi.advanceTimersByTime(1001);
    const stolen = await store.acquire(tenantId, 'worker-b', 1000);
    expect(stolen).not.toBeNull();

    // worker-a doesn't know it lost the lease yet -- its next renew must
    // report that plainly rather than silently extending worker-b's lease.
    const result = await store.renew(tenantId, 'worker-a', grant.leaseToken, 1000);
    expect(result).toBeNull();

    const lease = await store.getLease(tenantId);
    expect(lease.workerId).toBe('worker-b');
    await store.close();
  });

  it('release frees the lease for another worker to acquire', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);
    const grant = await store.acquire(tenantId, 'worker-a');

    const released = await store.release(tenantId, 'worker-a', grant.leaseToken);
    expect(released).toBe(true);

    const lease = await store.getLease(tenantId);
    expect(lease).toEqual({
      _id: tenantId,
      workerId: null,
      leaseToken: null,
      expiresAt: null
    });

    expect(await store.acquire(tenantId, 'worker-b')).not.toBeNull();
    await store.close();
  });

  it('release is a no-op (returns false) if the caller no longer holds the lease', async () => {
    const store = await openStore();
    const tenantId = new ObjectId();
    await store.provisionTenant(tenantId);
    const grant = await store.acquire(tenantId, 'worker-a', 1000);

    vi.advanceTimersByTime(1001);
    await store.acquire(tenantId, 'worker-b', 1000); // reclaims it

    expect(await store.release(tenantId, 'worker-a', grant.leaseToken)).toBe(false);
    expect((await store.getLease(tenantId)).workerId).toBe('worker-b');
    await store.close();
  });

  it('leases for different tenants are independent', async () => {
    const store = await openStore();
    const tenantA = new ObjectId();
    const tenantB = new ObjectId();
    await store.provisionTenant(tenantA);
    await store.provisionTenant(tenantB);

    expect(await store.acquire(tenantA, 'worker-a')).not.toBeNull();
    expect(await store.acquire(tenantB, 'worker-a')).not.toBeNull();
    expect((await store.getLease(tenantA)).workerId).toBe('worker-a');
    expect((await store.getLease(tenantB)).workerId).toBe('worker-a');
    await store.close();
  });
});
