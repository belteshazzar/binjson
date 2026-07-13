/**
 * db-coordinator.js — multi-tab/multi-worker coordination for the OPFS-backed
 * document database (docs/db-plan.md, "Open decisions / risks: OPFS
 * concurrency").
 *
 * FileSystemSyncAccessHandle (what every OPFS file in this repo uses, via
 * OPFSStorageProvider/registerHandle in binjson-wasm.js) takes an exclusive,
 * origin-wide lock per file: only one context can have a collection's files
 * open at a time. `connectShared` lets many tabs/workers share one logical
 * database anyway, by electing exactly one of them the "leader" (the only
 * one that actually opens the real Db/OPFS files) and proxying every other
 * context's calls to it.
 *
 * This module must run somewhere with `navigator.locks`/`BroadcastChannel`
 * — a dedicated Worker, matching the existing constraint that OPFS access
 * itself already requires a Worker (see README.md, public/worker.js). Every
 * tab already needs its own worker for OPFS regardless of this feature, so
 * the whole coordinator — election, RPC, and the real Db — lives inside
 * that worker; the tab's main thread is unaware any of this exists and
 * talks to its own worker exactly as it always has.
 *
 * Coordination mechanism (chosen over a SharedWorker-as-sole-owner design
 * specifically because iOS Safari has never supported SharedWorker at all,
 * which would silently break multi-tab on a platform this repo already
 * targets via OPFS's own Safari 16.4+ requirement):
 *
 *   - Leader election: `navigator.locks.request(lockName, ...)` — the
 *     context whose callback fires holds the lock (is the leader) until it
 *     releases it (on close()), at which point the next queued context is
 *     granted the lock automatically. No polling, no split-brain: the
 *     browser guarantees at most one holder.
 *   - RPC: one BroadcastChannel per logical database. Followers broadcast
 *     `request` messages; whichever context currently holds the lock is the
 *     only one listening for them and replies with `response`/`error`.
 *     Payloads are binjson-encoded (encode/decode from ./binjson.js, the
 *     same codec every document already round-trips through) rather than
 *     JSON, so ObjectId/Date survive the trip unchanged.
 *
 * `SharedDb`/`SharedCollection` mirror Db/Collection's public API exactly
 * (src/binjson-wasm.js) so existing single-tab code barely changes to adopt
 * this; the only structural difference is `find()`'s cursor resolving with
 * one RPC call on `.toArray()`, matching the real cursor's own laziness.
 */
import { encode, decode } from './binjson.js';
import { connect } from './db.js';

const REQUEST_TIMEOUT_MS = 5000;
const REELECT_WAIT_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 2000;

function lockName(dbName) { return `binjson-db-lock:${dbName}`; }
function channelName(dbName) { return `binjson-db-coord:${dbName}`; }

/**
 * Run the real db.collection(name)[method](...args) (or db[method](...args)
 * when collectionName is null), special-casing 'find' since the real
 * Collection.find() returns a lazy cursor rather than a promise — RPC
 * always wants the fully resolved array. Shared by the leader's own local
 * calls and its handling of followers' `request` messages, so there is
 * exactly one execution path regardless of who is asking.
 */
async function executeOnRealDb(realDb, collectionName, method, args) {
  if (collectionName === null) return realDb[method](...args);
  const coll = await realDb.collection(collectionName);
  if (method === 'find') {
    const [filter, options] = args;
    return coll.find(filter, options).toArray();
  }
  return coll[method](...args);
}

class Coordinator {
  constructor(dbName) {
    this.dbName = dbName;
    this.role = 'unknown'; // 'unknown' | 'leader' | 'follower'
    this.realDb = null;
    this.channel = new BroadcastChannel(channelName(dbName));
    this.pending = new Map(); // requestId -> { resolve, reject }
    this._roleResolvers = [];  // resolved once, on the first role transition
    this._leaderSignalResolvers = []; // resolved (repeatedly) on any leader sighting
    this._heartbeatTimer = null;
    this._resolveHold = null;
    this._closed = false;

    this.channel.addEventListener('message', (event) => this._onMessage(event.data));
  }

  async start(provider, options) {
    const holdPromise = new Promise((resolve) => { this._resolveHold = resolve; });
    let rejectStart;
    const startFailed = new Promise((_, reject) => { rejectStart = reject; });

    // Fired, not awaited: resolves only once this context is granted the
    // lock, i.e. becomes leader. Not awaiting lets connect() return as soon
    // as *either* this fires or another leader announces itself.
    this._abortController = new AbortController();
    navigator.locks.request(lockName(this.dbName), { mode: 'exclusive', signal: this._abortController.signal }, async () => {
      if (this._closed) return; // closed before the lock was granted -- release immediately
      try {
        await this._becomeLeader(provider, options);
      } catch (err) {
        rejectStart(err);
        return; // never became leader; release the lock for the next waiter
      }
      return holdPromise;
    }).catch((err) => {
      if (err && err.name === 'AbortError') return; // expected: close() before the lock was granted
      rejectStart(err);
    });

    const becameLeader = new Promise((resolve) => this._roleResolvers.push(resolve));
    this.channel.postMessage({ type: 'whoIsLeader' });
    await Promise.race([becameLeader, startFailed]); // settles via _becomeLeader(), an iAmLeader/announce reply, or connect() failing
  }

  async _becomeLeader(provider, options) {
    if (this.role !== 'leader') this.realDb = await connect(provider, options);
    this.role = 'leader';
    this.channel.postMessage({ type: 'announce' });
    this._settleRole();
    this._notifyLeaderSignal();
    if (!this._heartbeatTimer) {
      this._heartbeatTimer = setInterval(() => {
        if (this.role === 'leader') this.channel.postMessage({ type: 'announce' });
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  _settleRole() {
    const resolvers = this._roleResolvers;
    this._roleResolvers = [];
    for (const r of resolvers) r();
  }

  _notifyLeaderSignal() {
    const resolvers = this._leaderSignalResolvers;
    this._leaderSignalResolvers = [];
    for (const r of resolvers) r();
  }

  /** Resolves on the next iAmLeader/announce/self-election, or after `ms`. */
  _waitForLeaderSignal(ms) {
    return new Promise((resolve) => {
      this._leaderSignalResolvers.push(resolve);
      setTimeout(resolve, ms);
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'whoIsLeader':
        if (this.role === 'leader') this.channel.postMessage({ type: 'iAmLeader' });
        return;
      case 'iAmLeader':
      case 'announce':
        if (this.role === 'unknown') { this.role = 'follower'; this._settleRole(); }
        this._notifyLeaderSignal();
        return;
      case 'request':
        if (this.role === 'leader') this._handleRequest(msg);
        return;
      case 'response':
      case 'error': {
        const p = this.pending.get(msg.requestId);
        if (!p) return; // not ours, or already timed out
        this.pending.delete(msg.requestId);
        if (msg.type === 'error') p.reject(new Error(decode(msg.payload).message));
        else p.resolve(decode(msg.payload));
        return;
      }
    }
  }

  async _handleRequest(msg) {
    const [collectionName, method, args] = decode(msg.payload);
    try {
      const result = await executeOnRealDb(this.realDb, collectionName, method, args);
      this.channel.postMessage({ type: 'response', requestId: msg.requestId, payload: encode(result === undefined ? null : result) });
    } catch (err) {
      this.channel.postMessage({ type: 'error', requestId: msg.requestId, payload: encode({ message: err.message }) });
    }
  }

  async _rpcCall(collectionName, method, args, retried = false) {
    // Re-checked on every (re)entry, not just in dispatch(): if this very
    // context was promoted to leader while an earlier attempt was in
    // flight, a broadcast request it sent as a follower will never be
    // answered (BroadcastChannel never delivers a context's own messages
    // back to itself) -- serve locally instead of retrying over the wire.
    if (this.role === 'leader') return executeOnRealDb(this.realDb, collectionName, method, args);
    const requestId = crypto.randomUUID();
    const payload = encode([collectionName, method, args]);
    const result = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.channel.postMessage({ type: 'request', requestId, payload });

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`db-coordinator: request timed out (${method})`)), REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([result, timeout]);
    } catch (err) {
      this.pending.delete(requestId);
      if (retried) throw err;
      // The leader may be gone (its tab/worker closed): re-broadcast and
      // give a new leader a bounded window to appear (either another
      // follower's announce, or our own lock finally being granted) before
      // one bounded retry of the original call.
      this.channel.postMessage({ type: 'whoIsLeader' });
      await this._waitForLeaderSignal(REELECT_WAIT_MS);
      return this._rpcCall(collectionName, method, args, true);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async dispatch(collectionName, method, args) {
    if (this.role === 'leader') return executeOnRealDb(this.realDb, collectionName, method, args);
    return this._rpcCall(collectionName, method, args);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const { reject } of this.pending.values()) reject(new Error('db-coordinator: closed'));
    this.pending.clear();
    if (this.role === 'leader' && this.realDb) await this.realDb.close();
    if (this._abortController) this._abortController.abort(); // cancel the lock request if still queued
    if (this._resolveHold) this._resolveHold(); // release the Web Lock, if held
    this.channel.close();
  }
}

class SharedCollection {
  constructor(coordinator, name) {
    this._coord = coordinator;
    this.name = name;
  }

  async createIndex(keys, options = {}) { return this._coord.dispatch(this.name, 'createIndex', [keys, options]); }
  async dropIndex(name) { return this._coord.dispatch(this.name, 'dropIndex', [name]); }
  async listIndexes() { return this._coord.dispatch(this.name, 'listIndexes', []); }
  async findByIndex(name, values) { return this._coord.dispatch(this.name, 'findByIndex', [name, values]); }
  async insertOne(doc) { return this._coord.dispatch(this.name, 'insertOne', [doc]); }
  async findOne(filter = {}) { return this._coord.dispatch(this.name, 'findOne', [filter]); }

  /** Mirrors Collection.find()'s laziness (src/binjson-wasm.js): chain
   * setters mutate local state only; toArray()/iteration make exactly one
   * RPC call with the fully resolved filter+options. */
  find(filter = {}, options = {}) {
    const coord = this._coord, name = this.name;
    const state = {
      sort: options.sort || null,
      skip: options.skip || 0,
      limit: options.limit || 0,
      projection: options.projection || null
    };
    const cursor = {
      sort(spec) { state.sort = spec; return cursor; },
      skip(n) { state.skip = n; return cursor; },
      limit(n) { state.limit = n; return cursor; },
      project(spec) { state.projection = spec; return cursor; },
      async toArray() { return coord.dispatch(name, 'find', [filter, { ...state }]); },
      async *[Symbol.asyncIterator]() { for (const doc of await this.toArray()) yield doc; }
    };
    return cursor;
  }

  async deleteOne(filter = {}) { return this._coord.dispatch(this.name, 'deleteOne', [filter]); }
  async replaceOne(filter, replacement, options = {}) { return this._coord.dispatch(this.name, 'replaceOne', [filter, replacement, options]); }
  async updateOne(filter, update, options = {}) { return this._coord.dispatch(this.name, 'updateOne', [filter, update, options]); }
  async updateMany(filter, update, options = {}) { return this._coord.dispatch(this.name, 'updateMany', [filter, update, options]); }
  async countDocuments(filter = {}) { return this._coord.dispatch(this.name, 'countDocuments', [filter]); }
}

class SharedDb {
  constructor(coordinator) {
    this._coord = coordinator;
  }

  /** Synchronous like Db.collection is async in name only -- no per-name
   * open step is needed client-side; the leader opens (or reuses its own
   * already-open) real Collection lazily on first RPC for that name. */
  async collection(name) { return new SharedCollection(this._coord, name); }
  async listCollections() { return this._coord.dispatch(null, 'listCollections', []); }
  async dropCollection(name) { return this._coord.dispatch(null, 'dropCollection', [name]); }
  async close() { return this._coord.close(); }
}

/**
 * Join (or create) a database shared across every tab/worker that calls
 * connectShared with the same `dbName` against the same OPFS directory.
 * Exactly one caller becomes the leader and actually opens `provider`'s
 * files; every other caller transparently proxies to it. `options` is
 * forwarded to connect() (src/db.js) verbatim.
 */
async function connectShared(dbName, provider, options) {
  if (typeof dbName !== 'string' || dbName.length === 0) {
    throw new Error(`Invalid dbName: ${JSON.stringify(dbName)}`);
  }
  if (typeof navigator === 'undefined' || !navigator.locks || typeof BroadcastChannel === 'undefined') {
    throw new Error('connectShared requires navigator.locks and BroadcastChannel (run it inside a Worker)');
  }
  const coordinator = new Coordinator(dbName);
  await coordinator.start(provider, options);
  return new SharedDb(coordinator);
}

export { connectShared };
