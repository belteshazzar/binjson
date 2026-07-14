import { describe, it, expect } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { ObjectId } from '../src/binjson.js';
import { MemoryStorageProvider } from '../src/db.js';
import { TenantRegistry } from '../service/tenant-registry.js';

await ready();

describe('TenantRegistry', () => {
  it('createTenant issues a resolvable API key for a fresh tenant id', async () => {
    const registry = await TenantRegistry.open(new MemoryStorageProvider());
    const { tenantId, apiKey } = await registry.createTenant();

    expect(tenantId).toBeInstanceOf(ObjectId);
    expect(typeof apiKey).toBe('string');

    const resolved = await registry.resolveApiKey(apiKey);
    expect(resolved.equals(tenantId)).toBe(true);
  });

  it('resolveApiKey returns null for an unknown key', async () => {
    const registry = await TenantRegistry.open(new MemoryStorageProvider());
    await registry.createTenant();
    expect(await registry.resolveApiKey('sk_not-a-real-key')).toBeNull();
  });

  it('never stores the plaintext API key', async () => {
    const registry = await TenantRegistry.open(new MemoryStorageProvider());
    const { apiKey } = await registry.createTenant();

    const stored = await registry.tenants.findOne({});
    expect(JSON.stringify(stored)).not.toContain(apiKey);
    expect(stored.apiKeyHash).toHaveLength(64); // hex sha256
  });

  it('two tenants get distinct, independently resolvable keys', async () => {
    const registry = await TenantRegistry.open(new MemoryStorageProvider());
    const a = await registry.createTenant();
    const b = await registry.createTenant();

    expect((await registry.resolveApiKey(a.apiKey)).equals(a.tenantId)).toBe(true);
    expect((await registry.resolveApiKey(b.apiKey)).equals(b.tenantId)).toBe(true);
  });
});
