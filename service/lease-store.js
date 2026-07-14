/**
 * service/lease-store.js — tenant-ownership leases for the cloud gateway.
 *
 * Backed by this project's own document database rather than Postgres or
 * Redis (see docs/cloud-rest-api.md's routing discussion). One binjson
 * `Db`, one `leases` collection, one row per tenant keyed by the tenant's
 * own `_id`. A lease row records which worker currently owns that
 * tenant's data files, so the gateway never routes two workers to the
 * same tenant at once.
 *
 * This store inherits the same single-writer constraint it exists to
 * enforce for tenant data: exactly one process may have this database
 * open. Every gateway/worker instance talks to that one process over the
 * network (or in-process, if the gateway and lease owner are the same
 * process) — nothing here assumes multiple processes share the file
 * directly.
 *
 * Correctness of acquire/renew/release rests on one fact: `updateOne`
 * compiles a filter match and a write into a single WASM call (see
 * docs/db-plan.md's "one `*w_*` export per operation" rule) — there is
 * no read-then-write gap a second concurrent call could land in, so a
 * conditional `updateOne` is a real compare-and-swap, not a race.
 */
import { connect } from '../src/db.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 30_000;

class LeaseStore {
  static async open(provider, options = {}) {
    const db = await connect(provider, options);
    const leases = await db.collection('leases');
    return new LeaseStore(db, leases);
  }

  /** Share an already-open control-plane Db (see service/control-plane.js) instead of opening a fresh one. */
  static async fromDb(db) {
    const leases = await db.collection('leases');
    return new LeaseStore(db, leases);
  }

  constructor(db, leases) {
    this.db = db;
    this.leases = leases;
  }

  async close() {
    await this.db.close();
  }

  /**
   * Create the lease row for a new tenant, unclaimed. Call once, at
   * tenant provisioning time — not on the hot acquire path, so it doesn't
   * need compare-and-swap semantics of its own, just idempotency.
   */
  async provisionTenant(tenantId) {
    try {
      await this.leases.insertOne({
        _id: tenantId,
        workerId: null,
        leaseToken: null,
        expiresAt: null
      });
    } catch (err) {
      if (!isDuplicateIdError(err)) throw err;
    }
  }

  /**
   * Claim ownership of `tenantId` for `workerId`. Succeeds if the lease
   * is unheld or its TTL has passed. Returns `{ leaseToken, expiresAt }`
   * on success — `leaseToken` must be presented to `renew`/`release`, and
   * is also what gets embedded in signed cursor ids (see
   * docs/cloud-rest-api.md) so a cursor opened under a since-revoked
   * lease fails verification instead of reaching whichever tenant
   * happens to occupy that worker slot now. Returns `null` if another
   * worker already holds a live lease.
   */
  async acquire(tenantId, workerId, ttlMs = DEFAULT_TTL_MS) {
    const now = new Date();
    const leaseToken = randomUUID();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const { matchedCount } = await this.leases.updateOne(
      {
        _id: tenantId,
        $or: [{ workerId: null }, { expiresAt: { $lt: now } }]
      },
      { $set: { workerId, leaseToken, expiresAt } }
    );
    return matchedCount === 1 ? { leaseToken, expiresAt } : null;
  }

  /**
   * Extend a lease this worker currently holds. Returns the new
   * `expiresAt` on success, or `null` if the lease was already lost
   * (expired and reclaimed by another worker, or revoked) — the caller
   * must treat `null` as "I no longer own this tenant": stop serving it,
   * close its files, drop any open cursors/subscriptions for it.
   */
  async renew(tenantId, workerId, leaseToken, ttlMs = DEFAULT_TTL_MS) {
    const expiresAt = new Date(Date.now() + ttlMs);
    const { matchedCount } = await this.leases.updateOne(
      { _id: tenantId, workerId, leaseToken },
      { $set: { expiresAt } }
    );
    return matchedCount === 1 ? expiresAt : null;
  }

  /**
   * Voluntarily give up a lease this worker currently holds (idle
   * eviction, graceful shutdown). Returns `false` if this worker didn't
   * hold it — already lost to expiry/reclaim, so there's nothing to
   * release.
   */
  async release(tenantId, workerId, leaseToken) {
    const { matchedCount } = await this.leases.updateOne(
      { _id: tenantId, workerId, leaseToken },
      { $set: { workerId: null, leaseToken: null, expiresAt: null } }
    );
    return matchedCount === 1;
  }

  /**
   * Current lease state, for the gateway's routing decision:
   * `workerId`/`expiresAt` non-null and `expiresAt > now` means hot
   * (route there); otherwise cold (some worker must `acquire` first).
   */
  async getLease(tenantId) {
    return this.leases.findOne({ _id: tenantId });
  }
}

function isDuplicateIdError(err) {
  return err instanceof Error && /Duplicate _id/.test(err.message);
}

export { LeaseStore, DEFAULT_TTL_MS };
