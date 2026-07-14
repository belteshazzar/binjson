import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObjectId } from '../src/binjson.js';
import { TokenBucketRateLimiter, PerTenantLimitCounter } from '../service/rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows bursts up to capacity, then rejects with a retryAfterSec', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSec: 1 });
    const tenantId = new ObjectId();

    expect(limiter.tryConsume(tenantId)).toEqual({ allowed: true });
    expect(limiter.tryConsume(tenantId)).toEqual({ allowed: true });
    expect(limiter.tryConsume(tenantId)).toEqual({ allowed: true });

    const rejected = limiter.tryConsume(tenantId);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('refills over time at refillPerSec, allowing more requests after waiting', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 1 });
    const tenantId = new ObjectId();

    expect(limiter.tryConsume(tenantId).allowed).toBe(true);
    expect(limiter.tryConsume(tenantId).allowed).toBe(true);
    expect(limiter.tryConsume(tenantId).allowed).toBe(false);

    vi.advanceTimersByTime(1000); // one full token's worth of refill
    expect(limiter.tryConsume(tenantId).allowed).toBe(true);
    expect(limiter.tryConsume(tenantId).allowed).toBe(false);
  });

  it('never refills past capacity even after a long idle gap', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 100 });
    const tenantId = new ObjectId();
    limiter.tryConsume(tenantId);

    vi.advanceTimersByTime(60_000); // would be 6000 tokens' worth without the cap
    expect(limiter.tryConsume(tenantId).allowed).toBe(true);
    expect(limiter.tryConsume(tenantId).allowed).toBe(true);
    expect(limiter.tryConsume(tenantId).allowed).toBe(false); // capped at 2, not unbounded
  });

  it('tracks separate tenants independently', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSec: 1 });
    const a = new ObjectId();
    const b = new ObjectId();
    expect(limiter.tryConsume(a).allowed).toBe(true);
    expect(limiter.tryConsume(a).allowed).toBe(false);
    expect(limiter.tryConsume(b).allowed).toBe(true); // unaffected by a's exhausted bucket
  });
});

describe('PerTenantLimitCounter', () => {
  it('allows up to max concurrent, then rejects', () => {
    const counter = new PerTenantLimitCounter(2);
    const tenantId = new ObjectId();
    expect(counter.tryAcquire(tenantId)).toBe(true);
    expect(counter.tryAcquire(tenantId)).toBe(true);
    expect(counter.tryAcquire(tenantId)).toBe(false);
    expect(counter.count(tenantId)).toBe(2);
  });

  it('release() frees a slot for a subsequent acquire', () => {
    const counter = new PerTenantLimitCounter(1);
    const tenantId = new ObjectId();
    expect(counter.tryAcquire(tenantId)).toBe(true);
    expect(counter.tryAcquire(tenantId)).toBe(false);
    counter.release(tenantId);
    expect(counter.tryAcquire(tenantId)).toBe(true);
  });

  it('release() on an already-zero tenant is a safe no-op', () => {
    const counter = new PerTenantLimitCounter(1);
    const tenantId = new ObjectId();
    expect(() => counter.release(tenantId)).not.toThrow();
    expect(counter.count(tenantId)).toBe(0);
  });

  it('tracks separate tenants independently', () => {
    const counter = new PerTenantLimitCounter(1);
    const a = new ObjectId();
    const b = new ObjectId();
    expect(counter.tryAcquire(a)).toBe(true);
    expect(counter.tryAcquire(b)).toBe(true); // unaffected by a's full slot
  });
});
