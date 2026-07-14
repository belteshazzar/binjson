import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { ObjectId } from '../src/binjson.js';
import { MemoryStorageProvider } from '../src/db.js';
import { LeaseStore } from '../service/lease-store.js';
import { TenantWorker, TenantUnavailableError } from '../service/tenant-worker.js';

await ready();

describe('TenantWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeWorker(workerId, leaseStore, ttlMs = 1000) {
    return new TenantWorker({
      leaseStore,
      workerId,
      createProvider: () => new MemoryStorageProvider(),
      ttlMs
    });
  }

  it('open() acquires the lease, opens the Db, and caches it for repeat calls', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const worker = await makeWorker('worker-a', leaseStore);
    const db = await worker.open(tenantId);
    expect(await db.listCollections()).toEqual([]);

    const db2 = await worker.open(tenantId);
    expect(db2).toBe(db); // same instance, no second acquire

    const lease = await leaseStore.getLease(tenantId);
    expect(lease.workerId).toBe('worker-a');
  });

  it('concurrent open() calls for the same tenant share one acquisition', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const worker = await makeWorker('worker-a', leaseStore);
    const [dbA, dbB] = await Promise.all([worker.open(tenantId), worker.open(tenantId)]);
    expect(dbA).toBe(dbB);
  });

  it('a second worker cannot open a tenant already held live by another', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const workerA = await makeWorker('worker-a', leaseStore);
    const workerB = await makeWorker('worker-b', leaseStore);

    await workerA.open(tenantId);
    await expect(workerB.open(tenantId)).rejects.toThrow(TenantUnavailableError);
  });

  it('heartbeat renewal keeps the lease alive past its original TTL', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const worker = await makeWorker('worker-a', leaseStore, 900); // renewIntervalMs = 300
    await worker.open(tenantId);

    // Past the original 900ms TTL, but renewals every 300ms should have
    // kept it alive throughout.
    await vi.advanceTimersByTimeAsync(2500);

    const workerB = await makeWorker('worker-b', leaseStore);
    await expect(workerB.open(tenantId)).rejects.toThrow(TenantUnavailableError);
  });

  it('losing the lease to another party closes the Db and stops renewing', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const workerA = await makeWorker('worker-a', leaseStore, 500); // renewIntervalMs = 166
    const db = await workerA.open(tenantId);

    // Simulate the lease being reassigned out from under worker-a --
    // written directly to the row rather than through worker-a, standing
    // in for whatever external event caused it (a forced reclaim, a race
    // worker-a didn't observe). worker-a's own heartbeat is still running
    // fine; what's being tested is that its next renewal correctly
    // notices the token no longer matches and reacts, not that it goes
    // silent on its own.
    await leaseStore.leases.updateOne(
      { _id: tenantId },
      { $set: { workerId: 'worker-b', leaseToken: 'stolen-token', expiresAt: new Date(Date.now() + 10_000) } }
    );

    // worker-a's next scheduled renewal attempt should now fail and force-close its Db.
    await vi.advanceTimersByTimeAsync(200);

    expect((await leaseStore.getLease(tenantId)).workerId).toBe('worker-b');
    await expect(db.listCollections()).rejects.toThrow(); // closed out from under it
  });

  it('release() closes the Db and hands the lease back for another worker to acquire', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantId = new ObjectId();
    await leaseStore.provisionTenant(tenantId);

    const workerA = await makeWorker('worker-a', leaseStore);
    const db = await workerA.open(tenantId);
    await workerA.release(tenantId);

    expect((await leaseStore.getLease(tenantId)).workerId).toBeNull();
    await expect(db.listCollections()).rejects.toThrow();

    const workerB = await makeWorker('worker-b', leaseStore);
    await expect(workerB.open(tenantId)).resolves.toBeTruthy();
  });

  it('closeAll() releases every tenant this worker currently holds', async () => {
    const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
    const tenantA = new ObjectId();
    const tenantB = new ObjectId();
    await leaseStore.provisionTenant(tenantA);
    await leaseStore.provisionTenant(tenantB);

    const worker = await makeWorker('worker-a', leaseStore);
    await worker.open(tenantA);
    await worker.open(tenantB);

    await worker.closeAll();

    expect((await leaseStore.getLease(tenantA)).workerId).toBeNull();
    expect((await leaseStore.getLease(tenantB)).workerId).toBeNull();
  });

  describe('idle eviction', () => {
    async function makeIdleWorker(leaseStore, overrides = {}) {
      return new TenantWorker({
        leaseStore,
        workerId: 'worker-a',
        createProvider: () => new MemoryStorageProvider(),
        ttlMs: 10_000, // long enough that lease TTL never interferes with these tests
        idleTimeoutMs: 1000,
        idleSweepIntervalMs: 200,
        ...overrides
      });
    }

    it('releases a tenant nobody has touched past idleTimeoutMs', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantId = new ObjectId();
      await leaseStore.provisionTenant(tenantId);

      const worker = await makeIdleWorker(leaseStore);
      const db = await worker.open(tenantId);

      await vi.advanceTimersByTimeAsync(1200);

      expect((await leaseStore.getLease(tenantId)).workerId).toBeNull();
      await expect(db.listCollections()).rejects.toThrow(); // closed by the sweep
      worker.stop();
    });

    it('does not evict before idleTimeoutMs has elapsed', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantId = new ObjectId();
      await leaseStore.provisionTenant(tenantId);

      const worker = await makeIdleWorker(leaseStore);
      await worker.open(tenantId);

      await vi.advanceTimersByTimeAsync(600);
      expect((await leaseStore.getLease(tenantId)).workerId).toBe('worker-a');
      worker.stop();
    });

    it('touch() resets the idle clock, keeping an in-use tenant from being evicted', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantId = new ObjectId();
      await leaseStore.provisionTenant(tenantId);

      const worker = await makeIdleWorker(leaseStore);
      await worker.open(tenantId);

      await vi.advanceTimersByTimeAsync(800);
      worker.touch(tenantId);
      await vi.advanceTimersByTimeAsync(800); // 800ms since the touch -- still under the 1000ms threshold
      expect((await leaseStore.getLease(tenantId)).workerId).toBe('worker-a');

      await vi.advanceTimersByTimeAsync(400); // now 1200ms since the touch -- past it
      expect((await leaseStore.getLease(tenantId)).workerId).toBeNull();
    });

    it('idleTimeoutMs: Infinity disables idle eviction entirely', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantId = new ObjectId();
      await leaseStore.provisionTenant(tenantId);

      const worker = await makeIdleWorker(leaseStore, { idleTimeoutMs: Infinity });
      await worker.open(tenantId);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect((await leaseStore.getLease(tenantId)).workerId).toBe('worker-a');
      worker.stop();
    });

    it('stop() halts the sweep, leaving active tenants open past idleTimeoutMs', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantId = new ObjectId();
      await leaseStore.provisionTenant(tenantId);

      const worker = await makeIdleWorker(leaseStore);
      await worker.open(tenantId);
      worker.stop();

      await vi.advanceTimersByTimeAsync(5000);
      expect((await leaseStore.getLease(tenantId)).workerId).toBe('worker-a');
    });
  });

  describe('capacity (LRU eviction under maxActiveTenants)', () => {
    async function makeCappedWorker(leaseStore, maxActiveTenants) {
      return new TenantWorker({
        leaseStore,
        workerId: 'worker-a',
        createProvider: () => new MemoryStorageProvider(),
        ttlMs: 10_000,
        idleTimeoutMs: Infinity, // isolate capacity eviction from idle eviction in these tests
        maxActiveTenants
      });
    }

    it('does not evict while under the cap', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const [tenantA, tenantB] = [new ObjectId(), new ObjectId()];
      await leaseStore.provisionTenant(tenantA);
      await leaseStore.provisionTenant(tenantB);

      const worker = await makeCappedWorker(leaseStore, 2);
      await worker.open(tenantA);
      await worker.open(tenantB);

      expect((await leaseStore.getLease(tenantA)).workerId).toBe('worker-a');
      expect((await leaseStore.getLease(tenantB)).workerId).toBe('worker-a');
    });

    it('opening past the cap evicts the least-recently-touched active tenant', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const [tenantA, tenantB, tenantC] = [new ObjectId(), new ObjectId(), new ObjectId()];
      await leaseStore.provisionTenant(tenantA);
      await leaseStore.provisionTenant(tenantB);
      await leaseStore.provisionTenant(tenantC);

      const worker = await makeCappedWorker(leaseStore, 2);
      const dbA = await worker.open(tenantA);
      await vi.advanceTimersByTimeAsync(10); // establish a clear touch order between A and B
      await worker.open(tenantB);
      await vi.advanceTimersByTimeAsync(10);

      // Opening a third tenant exceeds the cap of 2 -- A (never touched
      // since its initial open) is the least-recently-used and gets
      // evicted to make room.
      await worker.open(tenantC);

      expect((await leaseStore.getLease(tenantA)).workerId).toBeNull();
      expect((await leaseStore.getLease(tenantB)).workerId).toBe('worker-a');
      expect((await leaseStore.getLease(tenantC)).workerId).toBe('worker-a');
      await expect(dbA.listCollections()).rejects.toThrow(); // closed by the eviction
    });

    it('touch() protects a tenant from being the LRU victim', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const [tenantA, tenantB, tenantC] = [new ObjectId(), new ObjectId(), new ObjectId()];
      await leaseStore.provisionTenant(tenantA);
      await leaseStore.provisionTenant(tenantB);
      await leaseStore.provisionTenant(tenantC);

      const worker = await makeCappedWorker(leaseStore, 2);
      await worker.open(tenantA);
      await vi.advanceTimersByTimeAsync(10);
      await worker.open(tenantB);
      await vi.advanceTimersByTimeAsync(10);

      // Without this, A would be the LRU victim (see previous test) --
      // touching it makes B the least-recently-used instead.
      worker.touch(tenantA);
      await vi.advanceTimersByTimeAsync(10);

      await worker.open(tenantC);

      expect((await leaseStore.getLease(tenantA)).workerId).toBe('worker-a');
      expect((await leaseStore.getLease(tenantB)).workerId).toBeNull();
      expect((await leaseStore.getLease(tenantC)).workerId).toBe('worker-a');
    });

    it('maxActiveTenants: Infinity (default) never evicts for capacity', async () => {
      const leaseStore = await LeaseStore.open(new MemoryStorageProvider());
      const tenantIds = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
      for (const id of tenantIds) await leaseStore.provisionTenant(id);

      const worker = await makeCappedWorker(leaseStore, Infinity);
      for (const id of tenantIds) await worker.open(id);

      for (const id of tenantIds) {
        expect((await leaseStore.getLease(id)).workerId).toBe('worker-a');
      }
    });
  });
});
