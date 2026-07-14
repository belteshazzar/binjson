/**
 * client/mongo-client.js — a MongoDB-driver-shaped client for the cloud
 * REST gateway (service/rest-gateway.js), matching docs/cloud-rest-api.md.
 *
 * This is the answer to "can a caller just use axios directly?" (yes, but
 * they'd have to hand-roll Extended JSON conversion and the cursor-
 * pagination loop on every call). This shim does both, plus maps wire
 * errors onto MongoServerError with a real `.code`/`.codeName` so
 * `err.code === 11000` works the way it would against a real MongoDB
 * driver. Built on the global `fetch()` (Node 18+) rather than axios or
 * any other HTTP library -- there's nothing about this transport that
 * needs one, and it keeps this package dependency-free.
 *
 * Method surface deliberately matches exactly what service/rest-gateway.js
 * implements today (insertOne/findOne/find/updateOne/deleteOne,
 * listCollections/dropCollection) -- not the full docs/cloud-rest-api.md
 * endpoint table, most of which doesn't have a server handler yet. Adding
 * a method here without a working endpoint behind it would be a shim that
 * lies about what it can do.
 *
 * `db(name)`: real MongoDB's `client.db(name)` selects among multiple
 * logical databases; here, `name` is accepted for driver-shim
 * compatibility but not used for routing -- the API key alone resolves
 * the tenant (see docs/cloud-rest-api.md's "Tenant = database, for v1").
 */
import { encode, decode } from './extended-json.js';

const DEFAULT_MAX_RETRIES = 3;

/** Thrown for any non-2xx response. Mirrors the real driver's MongoServerError: `.code`/`.codeName` are set when the server's error body carries them (see docs/cloud-rest-api.md's error format), undefined otherwise. */
class MongoServerError extends Error {
  constructor(message, { status, code, codeName } = {}) {
    super(message);
    this.name = 'MongoServerError';
    this.status = status;
    this.code = code;
    this.codeName = codeName;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors the embedded driver's ChangeStream (src/binjson-wasm.js) --
 * same EventEmitter-lite (`.on('change', cb)`/`.off(cb)`) plus async
 * iterator (`.next()`/`for await`) shape, same queue-until-consumed
 * semantics. The logic here is entirely transport-agnostic (it just
 * buffers/dispatches already-decoded change events); what differs from
 * the embedded version is purely how events arrive -- pushed over a
 * WebSocket instead of an in-process WASM callback.
 */
class ClientChangeStream {
  constructor(unsubscribe) {
    this._listeners = new Set();
    this._queue = [];
    this._waiting = []; // pending next() resolvers, FIFO
    this._closed = false;
    this._unsubscribe = unsubscribe;
  }

  _emit(change) {
    if (this._closed) return;
    for (const cb of this._listeners) cb(change);
    if (this._waiting.length) this._waiting.shift()({ value: change, done: false });
    else this._queue.push(change);
  }

  on(event, cb) {
    if (event !== 'change') throw new Error(`ChangeStream: unsupported event "${event}"`);
    this._listeners.add(cb);
    return this;
  }

  off(cb) {
    this._listeners.delete(cb);
    return this;
  }

  async next() {
    if (this._queue.length) return { value: this._queue.shift(), done: false };
    if (this._closed) return { value: undefined, done: true };
    return new Promise((resolve) => this._waiting.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async return() {
    this.close();
    return { value: undefined, done: true };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const waiting = this._waiting;
    this._waiting = [];
    for (const resolve of waiting) resolve({ value: undefined, done: true });
    if (this._unsubscribe) this._unsubscribe();
  }
}

class MongoClient {
  /**
   * @param {string} uri - the gateway's base URL. The API key may be
   *   embedded as userinfo (`https://<apiKey>@host`, mirroring real Mongo
   *   connection strings) or passed explicitly via `options.apiKey`.
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {number} [options.maxRetries] - automatic retries on a 503
   *   ("tenant temporarily unavailable" -- see docs/cloud-rest-api.md's
   *   error table) or a 429 (rate limited), honoring the server's
   *   Retry-After header either way. This is the shim absorbing a
   *   transient lease-handoff window or a burst over the rate limit
   *   transparently, the same way a real MongoDB driver's
   *   retryWrites/retryReads (or a Stripe-style client's automatic 429
   *   backoff) do for their own transient errors -- not something calling
   *   code should have to know happened.
   */
  constructor(uri, options = {}) {
    const url = new URL(uri);
    this._apiKey = options.apiKey ?? (url.username ? decodeURIComponent(url.username) : undefined);
    if (!this._apiKey) {
      throw new Error('MongoClient requires an API key: pass options.apiKey or embed it in the URI (https://<apiKey>@host)');
    }
    url.username = '';
    url.password = '';
    this._baseUrl = url.toString().replace(/\/$/, '');
    this._wsUrl = `${this._baseUrl.replace(/^http/, 'ws')}/v1/stream`;
    this._maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    // WebSocket state -- lazily connected on the first watch() call, not
    // in the constructor: most callers never call watch() at all, and a
    // REST-only client shouldn't pay for an idle socket it never needed.
    this._ws = null;
    this._wsConnectPromise = null;
    this._wsSubscriptions = new Map(); // subscriptionId -> { stream, collectionName }
    this._wsPendingRequests = new Map(); // requestId -> { resolve, reject }
    this._wsReconnectAttempts = 0;
    this._wsClosedByUser = false;
  }

  /** Validates the API key against the gateway eagerly, matching real drivers' fail-fast connect() rather than deferring to the first real call. */
  async connect() {
    await this._request('GET', '/v1/collections');
    return this;
  }

  db(name) {
    return new Db(this, name);
  }

  /** Closes the WebSocket connection (if one was ever opened) in addition to REST's no-op teardown. */
  async close() {
    this._wsClosedByUser = true;
    for (const { reject } of this._wsPendingRequests.values()) reject(new Error('MongoClient closed'));
    this._wsPendingRequests.clear();
    if (this._ws) {
      try {
        this._ws.close(1000, 'client closed');
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Opens (or reuses) the one WebSocket connection this client
   * multiplexes every watch() subscription over -- authenticates, then
   * resolves once `authAck` arrives. Concurrent watch() calls share this
   * same in-flight connect, never opening a second socket.
   */
  _ensureWsConnected() {
    if (this._wsConnectPromise) return this._wsConnectPromise;

    this._wsConnectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
      this._ws = ws;
      let authSettled = false;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', apiKey: this._apiKey }));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!authSettled) {
          authSettled = true;
          if (msg.type === 'authAck') {
            this._wsReconnectAttempts = 0;
            resolve();
          } else {
            reject(new Error(`WebSocket auth failed: ${msg.message ?? msg.type}`));
          }
          return;
        }
        this._handleWsMessage(msg);
      });

      ws.addEventListener('error', () => {
        if (!authSettled) {
          authSettled = true;
          reject(new Error('WebSocket connection error'));
        }
      });

      ws.addEventListener('close', (event) => {
        this._handleWsClose(event);
      });
    });

    return this._wsConnectPromise;
  }

  _wsSend(obj) {
    this._ws.send(JSON.stringify(obj));
  }

  /** Subscribes to a collection over the shared WS connection; resolves with the server-assigned subscriptionId once acked. */
  async _wsSubscribe(collectionName) {
    await this._ensureWsConnected();
    const requestId = crypto.randomUUID();
    const acked = new Promise((resolve, reject) => this._wsPendingRequests.set(requestId, { resolve, reject }));
    this._wsSend({ type: 'subscribe', requestId, collection: collectionName, pipeline: [] });
    return acked;
  }

  _handleWsMessage(msg) {
    switch (msg.type) {
      case 'subscribed': {
        const pending = this._wsPendingRequests.get(msg.requestId);
        if (!pending) return;
        this._wsPendingRequests.delete(msg.requestId);
        pending.resolve(msg.subscriptionId);
        return;
      }
      case 'subscribeError': {
        const pending = this._wsPendingRequests.get(msg.requestId);
        if (!pending) return;
        this._wsPendingRequests.delete(msg.requestId);
        pending.reject(new Error(msg.error?.message ?? 'subscribe failed'));
        return;
      }
      case 'change': {
        const entry = this._wsSubscriptions.get(msg.subscriptionId);
        if (entry) entry.stream._emit(decode(msg.event));
        return;
      }
      case 'ping':
        this._wsSend({ type: 'pong' });
        return;
      default:
        return; // pong/unsubscribed/error: nothing this client needs to act on
    }
  }

  /**
   * On an unexpected close (not a normal 1000 the caller initiated),
   * reconnect with capped exponential backoff and re-subscribe every
   * still-open ChangeStream from scratch -- there is no resume token
   * (docs/cloud-websocket-api.md), so "reconnect and resubscribe from
   * now" is the correct, complete recovery, not a partial one. Existing
   * ChangeStream objects the caller already holds keep working
   * transparently; only their subscriptionId changes underneath them.
   */
  async _handleWsClose(event) {
    this._ws = null;
    this._wsConnectPromise = null;
    for (const { reject } of this._wsPendingRequests.values()) reject(new Error('WebSocket connection closed'));
    this._wsPendingRequests.clear();

    if (this._wsClosedByUser || event.code === 1000) return;
    if (this._wsSubscriptions.size === 0) return;

    const attempt = ++this._wsReconnectAttempts;
    const backoffMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
    const jitteredMs = backoffMs * (0.75 + Math.random() * 0.5);
    await sleep(jitteredMs);
    if (this._wsClosedByUser) return;

    try {
      await this._ensureWsConnected();
      for (const [oldId, entry] of [...this._wsSubscriptions]) {
        this._wsSubscriptions.delete(oldId);
        try {
          const newId = await this._wsSubscribe(entry.collectionName);
          this._wsSubscriptions.set(newId, entry);
        } catch (err) {
          console.error(`[MongoClient] resubscribe to "${entry.collectionName}" failed after reconnect:`, err);
        }
      }
    } catch (err) {
      console.error('[MongoClient] websocket reconnect failed, will retry:', err);
      this._handleWsClose({ code: 1006 });
    }
  }

  async _request(method, path, body, _retriesLeft = this._maxRetries) {
    const headers = { Authorization: `Bearer ${this._apiKey}` };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(encode(body));
    }

    const res = await fetch(`${this._baseUrl}${path}`, { method, headers, body: payload });

    if ((res.status === 503 || res.status === 429) && _retriesLeft > 0) {
      const retryAfterMs = (Number(res.headers.get('retry-after')) || 1) * 1000;
      await sleep(retryAfterMs);
      return this._request(method, path, body, _retriesLeft - 1);
    }

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const message = parsed?.error?.message ?? `request failed with status ${res.status}`;
      throw new MongoServerError(message, {
        status: res.status,
        code: parsed?.error?.code,
        codeName: parsed?.error?.codeName
      });
    }
    return parsed ? decode(parsed) : null;
  }
}

class Db {
  constructor(client, name) {
    this._client = client;
    this.name = name;
  }

  collection(name) {
    return new Collection(this._client, name);
  }

  async listCollections() {
    const res = await this._client._request('GET', '/v1/collections');
    return res.collections;
  }

  async dropCollection(name) {
    await this._client._request('DELETE', `/v1/collections/${encodeURIComponent(name)}`);
    return true;
  }
}

class Collection {
  constructor(client, name) {
    this._client = client;
    this.name = name;
    this._path = `/v1/collections/${encodeURIComponent(name)}`;
  }

  async insertOne(doc) {
    const res = await this._client._request('POST', `${this._path}/insert-one`, { document: doc });
    return { acknowledged: true, insertedId: res.insertedId };
  }

  async findOne(filter = {}, options = {}) {
    const body = { filter };
    if (options.projection) body.projection = options.projection;
    const res = await this._client._request('POST', `${this._path}/find-one`, body);
    return res.document;
  }

  find(filter = {}, options = {}) {
    return new FindCursor(this._client, this._path, filter, options);
  }

  async updateOne(filter, update, options = {}) {
    const body = { filter, update };
    if (options.upsert) body.upsert = true;
    return this._client._request('POST', `${this._path}/update-one`, body);
  }

  /**
   * Mirrors the embedded driver's watch(): returns a ChangeStream
   * synchronously, matching that API's shape, even though subscribing
   * here means a real network round trip (WS connect + auth + subscribe
   * ack) the embedded in-process version never needed. Events simply
   * start flowing once that round trip completes; `.on('change', cb)` or
   * `for await` can be wired up immediately without awaiting anything,
   * same as the embedded API.
   */
  watch(pipeline = [], options = {}) {
    if (pipeline.length) throw new Error('Collection.watch: pipeline stages are not supported yet');
    void options; // no options are honored yet -- accepted for signature parity

    const client = this._client;
    const stream = new ClientChangeStream(() => {
      for (const [id, entry] of client._wsSubscriptions) {
        if (entry.stream === stream) {
          client._wsSubscriptions.delete(id);
          if (client._ws) client._wsSend({ type: 'unsubscribe', subscriptionId: id });
          break;
        }
      }
    });

    client
      ._wsSubscribe(this.name)
      .then((subscriptionId) => {
        if (stream._closed) {
          // Caller closed before the subscribe ack arrived -- don't leave it registered server-side.
          if (client._ws) client._wsSend({ type: 'unsubscribe', subscriptionId });
          return;
        }
        client._wsSubscriptions.set(subscriptionId, { stream, collectionName: this.name });
      })
      .catch((err) => {
        console.error(`[MongoClient] watch() subscribe failed for "${this.name}":`, err);
        stream.close();
      });

    return stream;
  }

  async deleteOne(filter = {}) {
    return this._client._request('POST', `${this._path}/delete-one`, { filter });
  }
}

/**
 * Mirrors the embedded driver's find() cursor (src/binjson-wasm.js): a
 * lazy object with chainable `.sort()/.skip()/.limit()/.project()`, an
 * async `.next()` (`{ value, done }`), `.toArray()`, and `for await`
 * support. Backed by the REST cursor-pagination protocol
 * (docs/cloud-rest-api.md) -- the first `.next()`/`.toArray()` call fires
 * the initial `find` request; further pages are pulled via
 * `GET /v1/cursors/:id/next` as the buffered batch runs out.
 */
class FindCursor {
  constructor(client, collectionPath, filter, options) {
    this._client = client;
    this._collectionPath = collectionPath;
    this._filter = filter;
    this._options = { ...options };
    this._started = false;
    this._batch = [];
    this._batchIdx = 0;
    this._cursorId = null;
    this._exhausted = false;
  }

  sort(spec) {
    this._options.sort = spec;
    return this;
  }
  skip(n) {
    this._options.skip = n;
    return this;
  }
  limit(n) {
    this._options.limit = n;
    return this;
  }
  project(spec) {
    this._options.projection = spec;
    return this;
  }

  async _start() {
    this._started = true;
    const body = { filter: this._filter };
    if (this._options.sort) body.sort = this._options.sort;
    if (this._options.skip) body.skip = this._options.skip;
    if (this._options.limit) body.limit = this._options.limit;
    if (this._options.projection) body.projection = this._options.projection;
    const res = await this._client._request('POST', `${this._collectionPath}/find`, body);
    this._applyPage(res);
  }

  async _fetchMore() {
    const res = await this._client._request('GET', `/v1/cursors/${this._cursorId}/next`);
    this._applyPage(res);
  }

  _applyPage(res) {
    this._batch = res.batch;
    this._batchIdx = 0;
    this._cursorId = res.cursorId;
    if (!this._cursorId) this._exhausted = true;
  }

  async next() {
    if (!this._started) await this._start();
    if (this._batchIdx >= this._batch.length) {
      if (this._exhausted) return { value: undefined, done: true };
      await this._fetchMore();
      if (this._batch.length === 0) return { value: undefined, done: true };
    }
    return { value: this._batch[this._batchIdx++], done: false };
  }

  async toArray() {
    const all = [];
    for (let r = await this.next(); !r.done; r = await this.next()) all.push(r.value);
    return all;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  /** Invoked by `for await` on early exit (break/throw) -- releases the server-side cursor instead of leaving it to expire on its own idle TTL. */
  async return() {
    if (this._cursorId && !this._exhausted) {
      this._exhausted = true;
      const id = this._cursorId;
      this._cursorId = null;
      await this._client._request('DELETE', `/v1/cursors/${id}`).catch(() => {});
    }
    return { value: undefined, done: true };
  }
}

export { MongoClient, Db, Collection, FindCursor, ClientChangeStream, MongoServerError };
