/**
 * service/control-plane.js — bootstraps the one shared control-plane Db
 * (tenant identity + leases, see LeaseStore and TenantRegistry) as a
 * single binjson database with two collections, opened by exactly one
 * process.
 *
 * There is no lease on the control plane itself (nothing here calls
 * LeaseStore to arbitrate who may open it) -- by design there is only
 * ever one control-plane process. Whether "two control-plane processes
 * accidentally started at once" turns into an immediate, loud startup
 * failure (rather than two processes silently racing on the same
 * tenant/lease data) depends entirely on `provider`: an OPFSStorageProvider
 * backed by node-opfs 1.2.0+ takes a real cross-process `flock` on open
 * and gets this for free; a provider with no locking of its own (e.g.
 * MemoryStorageProvider, used throughout this repo's tests) gets no
 * protection here at all, the same caveat service/tenant-worker.js's own
 * header comment spells out for tenant Dbs.
 */
import { connect } from '../src/db.js';
import { LeaseStore } from './lease-store.js';
import { TenantRegistry } from './tenant-registry.js';

async function openControlPlane({ provider }) {
  const db = await connect(provider);
  const leaseStore = await LeaseStore.fromDb(db);
  const tenantRegistry = await TenantRegistry.fromDb(db);

  return {
    db,
    leaseStore,
    tenantRegistry,
    async close() {
      await db.close();
    }
  };
}

export { openControlPlane };
