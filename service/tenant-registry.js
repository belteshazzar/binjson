/**
 * service/tenant-registry.js — API key -> tenant identity, the auth half
 * of the control plane. Deliberately separate from LeaseStore: leasing is
 * about who owns a tenant's process right now (churns constantly);
 * identity is about who a caller is (essentially static). Different
 * concerns, different lifecycles, one row per tenant in each.
 *
 * Keys are hashed (SHA-256) before they ever touch storage -- this
 * project's document database is not a secrets vault, and there's no
 * reason a raw API key needs to survive on disk when only the hash is
 * ever compared against.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from '../src/db.js';

function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

class TenantRegistry {
  static async open(provider, options = {}) {
    const db = await connect(provider, options);
    return TenantRegistry._init(db);
  }

  /** Share an already-open control-plane Db (see service/control-plane.js) instead of opening a fresh one. */
  static async fromDb(db) {
    return TenantRegistry._init(db);
  }

  static async _init(db) {
    const tenants = await db.collection('tenants');
    try {
      await tenants.createIndex({ apiKeyHash: 1 }, { unique: true });
    } catch (err) {
      if (!(err instanceof Error && /already exists/.test(err.message))) throw err;
    }
    return new TenantRegistry(db, tenants);
  }

  constructor(db, tenants) {
    this.db = db;
    this.tenants = tenants;
  }

  async close() {
    await this.db.close();
  }

  /**
   * Provision a new tenant: generates its id and a fresh API key, stores
   * only the key's hash. The plaintext key is returned once, here, and
   * never again -- same handling as any bearer-credential issuance flow.
   */
  async createTenant() {
    const apiKey = `sk_${randomBytes(24).toString('hex')}`;
    const { insertedId: tenantId } = await this.tenants.insertOne({
      apiKeyHash: hashApiKey(apiKey),
      createdAt: new Date()
    });
    return { tenantId, apiKey };
  }

  /** The tenantId for a bearer API key, or null if it doesn't resolve to one. */
  async resolveApiKey(apiKey) {
    const doc = await this.tenants.findOne({ apiKeyHash: hashApiKey(apiKey) });
    return doc ? doc._id : null;
  }
}

export { TenantRegistry };
