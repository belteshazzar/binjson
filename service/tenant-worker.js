/**
 * service/tenant-worker.js — ties LeaseStore into the actual "one process
 * owns one tenant's Db at a time" lifecycle the rest of this design has
 * been building toward.
 *
 * `open(tenantId)`:
 *   1. Acquire the tenant's lease (LeaseStore) — throws
 *      TenantUnavailableError if another worker already holds a live one.
 *   2. Open its files via `createProvider(tenantId)`. LeaseStore is the
 *      *logical* coordinator; the hard backstop against two processes
 *      ever actually opening the same file (a stuck-not-crashed worker, a
 *      lease-table bug, a lease TTL raced against a slow request) is now
 *      node-opfs's own cross-process `flock` (1.2.0+, real OS-level,
 *      released automatically on crash — see StorageProvider's own
 *      history in git log for how that got verified). This module used
 *      to wrap every provider in its own LockedStorageProvider/`fs-ext`
 *      flock layer to own that guarantee directly rather than depend on
 *      upstream; removed once node-opfs 1.2.0 made that redundant for the
 *      provider this project actually ships. **This means the safety
 *      guarantee is only as real as whatever `createProvider` returns** —
 *      an `OPFSStorageProvider` backed by current node-opfs gets it,
 *      `MemoryStorageProvider` (used throughout this repo's tests) has no
 *      locking of any kind because there's no real file underneath it to
 *      lock, and a from-scratch StorageProvider would need to provide its
 *      own equivalent guarantee to be safe under multiple worker
 *      processes.
 *   3. Heartbeat-renew the lease at `ttlMs / 3` while the Db stays open.
 *      A failed renewal (lease lost — expired and reclaimed, or revoked)
 *      closes the Db immediately rather than continuing to serve a
 *      tenant this process no longer owns.
 *
 * Concurrent `open()` calls for the same tenant within one process share
 * one acquire-and-open in flight, rather than racing each other against
 * LeaseStore's compare-and-swap and having the second one fail spuriously
 * against its own worker's just-won lease.
 *
 * Idle eviction is a separate concern from the lease TTL above -- the
 * lease TTL answers "is this worker still alive," on the order of
 * seconds; idle eviction answers "has anyone actually used this tenant
 * recently," on the order of minutes, and exists purely to bound how
 * many tenants' files one process holds open at once. A periodic sweep
 * (not a per-tenant timer -- nothing here needs second-level precision)
 * releases any tenant untouched for `idleTimeoutMs`. `open()` counts as
 * a touch; callers that already hold a `Db` reference and don't call
 * `open()` again per request (an open cursor, an open watch()
 * subscription) must call `touch()` themselves or they'll look idle and
 * get evicted out from under them -- neither of those exists yet at this
 * layer, so nothing calls it today, but the hook exists so it isn't
 * retrofitted later.
 *
 * `maxActiveTenants` is the other half of that: idle eviction alone
 * doesn't bound worst-case resource use, because "not idle" doesn't
 * imply "not too many" -- a host can have more simultaneously-active
 * tenants than it has file descriptors/memory for, with every one of
 * them legitimately busy. This is a hard cap on this process's
 * concurrently-open tenants, matched to what the host can actually
 * carry; crossing it evicts the least-recently-touched active tenant to
 * make room for a new one, independent of whether that tenant has
 * crossed the idle threshold yet.
 */
import { connect } from '../src/db.js';
import { DEFAULT_TTL_MS } from './lease-store.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_ACTIVE_TENANTS = Infinity; // no cap unless the host says otherwise

class TenantUnavailableError extends Error {
  constructor(tenantId) {
    super(`Tenant ${tenantId} is owned by another worker`);
    this.name = 'TenantUnavailableError';
  }
}

class TenantWorker {
  /**
   * @param {object} opts
   * @param {import('./lease-store.js').LeaseStore} opts.leaseStore
   * @param {string} opts.workerId - identifies this process to LeaseStore.
   * @param {(tenantId) => object} opts.createProvider - returns a fresh
   *   StorageProvider for a tenant (e.g. an OPFSStorageProvider over that
   *   tenant's own subdirectory). Its cross-process locking, if any, is
   *   entirely up to what it returns — see this file's header comment.
   * @param {number} [opts.idleTimeoutMs] - release a tenant untouched for
   *   this long. `Infinity` disables idle eviction.
   * @param {number} [opts.idleSweepIntervalMs] - how often to check for
   *   idle tenants; only the eviction granularity, not its own timeout.
   * @param {number} [opts.maxActiveTenants] - hard cap on concurrently-open
   *   tenants in this process; sized to what the host can carry (file
   *   descriptors, memory). `Infinity` (default) disables the cap.
   * @param {(tenantId) => void|Promise} [opts.onTenantClosing] - called
   *   just before a tenant's Db closes, for any reason (lease lost,
   *   voluntary idle/capacity release) -- lets an external subscriber
   *   registry (the WebSocket gateway's open watch() subscriptions) react
   *   before the Db underneath it goes away. A thrown/rejected hook is
   *   caught and logged, never allowed to block the close it's reacting to.
   */
  constructor({
    leaseStore,
    workerId,
    createProvider,
    ttlMs = DEFAULT_TTL_MS,
    renewIntervalMs,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    idleSweepIntervalMs = DEFAULT_IDLE_SWEEP_INTERVAL_MS,
    maxActiveTenants = DEFAULT_MAX_ACTIVE_TENANTS,
    onTenantClosing = null
  }) {
    this.leaseStore = leaseStore;
    this.workerId = workerId;
    this.createProvider = createProvider;
    this.ttlMs = ttlMs;
    this.onTenantClosing = onTenantClosing;
    this.renewIntervalMs = renewIntervalMs ?? Math.floor(ttlMs / 3);
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxActiveTenants = maxActiveTenants;
    this._active = new Map(); // tenantKey -> { tenantId, db, leaseToken, timer, lastAccessedAt }
    this._opening = new Map(); // tenantKey -> in-flight open() promise

    this._idleSweepTimer = null;
    if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
      this._idleSweepTimer = setInterval(() => this._evictIdle(), idleSweepIntervalMs);
      this._idleSweepTimer.unref?.();
    }
  }

  /**
   * The open Db for a tenant: returns the already-active one, joins an
   * in-flight open already underway, or acquires the lease and opens it.
   * Throws TenantUnavailableError if another worker holds a live lease.
   * Counts as activity either way (see `touch`).
   *
   * Note: calling `release()` while an `open()` for the same tenant is
   * still in flight is a no-op (the entry isn't in `_active` yet) — not
   * handled here, since nothing in this design calls release() that
   * eagerly today.
   */
  async open(tenantId) {
    const key = tenantId.toString();
    const active = this._active.get(key);
    if (active) {
      active.lastAccessedAt = Date.now();
      return active.db;
    }

    const inFlight = this._opening.get(key);
    if (inFlight) return inFlight;

    const p = this._acquireAndOpen(tenantId, key);
    this._opening.set(key, p);
    try {
      return await p;
    } finally {
      this._opening.delete(key);
    }
  }

  /**
   * Mark a tenant as recently used without opening/returning it — for a
   * caller that already holds its own `Db` reference (an open cursor, an
   * open watch() subscription) and needs to keep it off the idle-eviction
   * sweep between `open()` calls. No-op if the tenant isn't active here.
   */
  touch(tenantId) {
    const entry = this._active.get(tenantId.toString());
    if (entry) entry.lastAccessedAt = Date.now();
  }

  async _acquireAndOpen(tenantId, key) {
    const grant = await this.leaseStore.acquire(tenantId, this.workerId, this.ttlMs);
    if (!grant) throw new TenantUnavailableError(tenantId);

    const provider = this.createProvider(tenantId);

    let db;
    try {
      db = await connect(provider);
    } catch (err) {
      await this.leaseStore.release(tenantId, this.workerId, grant.leaseToken);
      throw err;
    }

    const entry = { tenantId, db, leaseToken: grant.leaseToken, timer: null, lastAccessedAt: Date.now() };
    entry.timer = setInterval(() => {
      this._renew(tenantId, key).catch((err) => {
        console.error(`[TenantWorker] renew failed for tenant ${key}:`, err);
      });
    }, this.renewIntervalMs);
    entry.timer.unref?.();
    this._active.set(key, entry);

    if (this._active.size > this.maxActiveTenants) {
      await this._evictLRU().catch((err) => {
        console.error('[TenantWorker] LRU eviction under capacity pressure failed:', err);
      });
    }

    return db;
  }

  async _renew(tenantId, key) {
    const entry = this._active.get(key);
    if (!entry) return;
    const renewed = await this.leaseStore.renew(tenantId, this.workerId, entry.leaseToken, this.ttlMs);
    if (!renewed) await this._forceClose(key);
  }

  async _notifyClosing(tenantId) {
    if (!this.onTenantClosing) return;
    try {
      await this.onTenantClosing(tenantId);
    } catch (err) {
      console.error('[TenantWorker] onTenantClosing hook failed:', err);
    }
  }

  /** Lease lost underneath us: stop serving it, close its files. Don't try to release a lease we no longer hold. */
  async _forceClose(key) {
    const entry = this._active.get(key);
    if (!entry) return;
    this._active.delete(key);
    clearInterval(entry.timer);
    await this._notifyClosing(entry.tenantId);
    await entry.db.close();
  }

  /** Voluntary idle eviction: close the Db and hand the lease back. No-op if this tenant isn't active here. */
  async release(tenantId) {
    const key = tenantId.toString();
    const entry = this._active.get(key);
    if (!entry) return;
    this._active.delete(key);
    clearInterval(entry.timer);
    await this._notifyClosing(entry.tenantId);
    try {
      await entry.db.close();
    } finally {
      await this.leaseStore.release(tenantId, this.workerId, entry.leaseToken);
    }
  }

  /**
   * Capacity pressure, not idleness: release the least-recently-touched
   * active tenant to make room under `maxActiveTenants`. A heuristic, not
   * a guarantee against interrupting a live operation on the victim --
   * the same accepted tradeoff as lease loss elsewhere in this design
   * (the caller sees an error and can retry; the per-document commit
   * journal is what keeps an interrupted write from being corruption
   * rather than just a failed request). Concurrent opens of two
   * different new tenants can each independently decide to evict,
   * occasionally releasing one more tenant than strictly necessary under
   * a burst -- `release()` is a safe no-op on an already-released
   * tenant, so this over-corrects by at most a handful, it doesn't
   * double-free.
   */
  async _evictLRU() {
    let victim = null;
    for (const entry of this._active.values()) {
      if (!victim || entry.lastAccessedAt < victim.lastAccessedAt) victim = entry;
    }
    if (victim) await this.release(victim.tenantId);
  }

  /** Release every tenant untouched for longer than idleTimeoutMs. */
  _evictIdle() {
    const now = Date.now();
    const toEvict = [];
    for (const entry of this._active.values()) {
      if (now - entry.lastAccessedAt >= this.idleTimeoutMs) toEvict.push(entry.tenantId);
    }
    for (const tenantId of toEvict) {
      this.release(tenantId).catch((err) => {
        console.error(`[TenantWorker] idle eviction failed for tenant ${tenantId}:`, err);
      });
    }
  }

  /** Stop the idle-eviction sweep. Active tenants stay open until released/closed explicitly. */
  stop() {
    clearInterval(this._idleSweepTimer);
  }

  /** Graceful shutdown: stop the idle sweep and release every tenant this worker currently holds. */
  async closeAll() {
    this.stop();
    await Promise.all([...this._active.values()].map((entry) => this.release(entry.tenantId)));
  }
}

export { TenantWorker, TenantUnavailableError };
