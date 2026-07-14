/**
 * service/rate-limiter.js — in-memory, per-tenant rate/count limiting for
 * the REST and WebSocket gateways.
 *
 * Deliberately in-process, not routed through the control-plane document
 * DB the way LeaseStore/TenantRegistry are: those are low-frequency
 * operations (one lease acquire/renew per active tenant every few
 * seconds) well suited to a document DB's transactional semantics. Rate
 * limiting means a check on every single request/connection/subscribe --
 * potentially thousands per second across a fleet -- which would make
 * the control-plane Db the busiest thing touching it, for a workload it
 * isn't shaped for. In-memory counters are correct for this codebase's
 * current single-process gateway+worker shape (see rest-gateway.js's own
 * doc comment). Once gateway and worker actually split into separate
 * processes, per-process counters go wrong the same way any in-memory
 * state does across a fleet -- a shared, fast counter store (Redis's
 * INCR/EXPIRE is the standard tool for exactly this access pattern) would
 * replace this, not the control-plane Db.
 */

const DEFAULT_CAPACITY = 100; // burst allowance, in tokens
const DEFAULT_REFILL_PER_SEC = 50; // sustained rate, tokens/sec

/**
 * Per-tenant token bucket: bursts up to `capacity`, sustains
 * `refillPerSec` thereafter. One bucket is created lazily per tenant on
 * first use and never explicitly evicted -- for a real fleet with many
 * thousands of tenants this would want an idle-bucket sweep, the same
 * shape as TenantWorker's idle eviction; not built here since it's a
 * memory-hygiene concern, not a correctness one, and this is meant to be
 * outgrown by a shared store before that becomes the bottleneck.
 */
class TokenBucketRateLimiter {
  constructor({ capacity = DEFAULT_CAPACITY, refillPerSec = DEFAULT_REFILL_PER_SEC } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this._buckets = new Map(); // tenantKey -> { tokens, lastRefillAt }
  }

  /**
   * Attempts to consume `cost` tokens for `tenantId`. Returns
   * `{ allowed: true }` (and deducts the tokens) or `{ allowed: false,
   * retryAfterSec }` -- `retryAfterSec` is how long until enough tokens
   * have refilled, rounded up, suitable for a Retry-After header.
   */
  tryConsume(tenantId, cost = 1) {
    const key = tenantId.toString();
    const now = Date.now();
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillAt: now };
      this._buckets.set(key, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefillAt) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.lastRefillAt = now;
    }
    if (bucket.tokens < cost) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerSec)) };
    }
    bucket.tokens -= cost;
    return { allowed: true };
  }
}

/**
 * A plain "how many of X does this tenant currently have open" cap --
 * acquire/release, not a refilling rate. Used for both WS connection
 * count and WS subscription count (same shape, different `max`), rather
 * than two near-identical classes.
 */
class PerTenantLimitCounter {
  constructor(max) {
    this.max = max;
    this._counts = new Map(); // tenantKey -> count
  }

  /** True and increments if under `max`; false (no change) if already at it. */
  tryAcquire(tenantId) {
    const key = tenantId.toString();
    const count = this._counts.get(key) ?? 0;
    if (count >= this.max) return false;
    this._counts.set(key, count + 1);
    return true;
  }

  /** Decrements; safe to call on a tenant already at 0 (no-op). */
  release(tenantId) {
    const key = tenantId.toString();
    const count = this._counts.get(key) ?? 0;
    if (count <= 1) this._counts.delete(key);
    else this._counts.set(key, count - 1);
  }

  count(tenantId) {
    return this._counts.get(tenantId.toString()) ?? 0;
  }
}

export { TokenBucketRateLimiter, PerTenantLimitCounter };
