import { describe, it, expect } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { MemoryStorageProvider, OPFSStorageProvider } from '../src/db.js';
import { openControlPlane } from '../service/control-plane.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

describe('control plane bootstrap', () => {
  it('wires TenantRegistry and LeaseStore onto one shared Db', async () => {
    const cp = await openControlPlane({ provider: new MemoryStorageProvider() });

    const { tenantId, apiKey } = await cp.tenantRegistry.createTenant();
    await cp.leaseStore.provisionTenant(tenantId);

    expect((await cp.tenantRegistry.resolveApiKey(apiKey)).equals(tenantId)).toBe(true);
    expect((await cp.leaseStore.getLease(tenantId)).workerId).toBeNull();

    // Same underlying Db -- both collections live in it.
    expect((await cp.db.listCollections()).sort()).toEqual(['leases', 'tenants']);

    await cp.close();
  });

  // MemoryStorageProvider has no locking of any kind -- there's no real
  // file underneath it to lock -- so this specifically needs a real
  // OPFS-backed provider to mean anything: the guarantee that a second
  // control-plane process can't open the same store now comes entirely
  // from node-opfs's own cross-process flock (1.2.0+), not from anything
  // this project provides itself (see service/control-plane.js's header
  // comment).
  describe.skipIf(!hasOPFS)('cross-process exclusivity (real OPFS/node-opfs)', () => {
    it('a second control-plane process cannot open the same store concurrently', async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(`control-plane-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
        create: true
      });

      const cp = await openControlPlane({ provider: new OPFSStorageProvider(dir) });
      await expect(openControlPlane({ provider: new OPFSStorageProvider(dir) })).rejects.toThrow(/already open/i);

      await cp.close();
    });
  });
});
