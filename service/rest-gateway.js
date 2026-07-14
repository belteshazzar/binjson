/**
 * service/rest-gateway.js — a real HTTP server implementing a slice of
 * docs/cloud-rest-api.md against a TenantWorker: insert-one, find-one,
 * find (+ cursor pagination), update-one, delete-one, list-collections,
 * drop-collection. The rest of the endpoint table is the same pattern
 * repeated (parse body, call the matching Collection method, encode the
 * result) -- this covers every *structurally* distinct case (simple
 * write, simple read, the cursor protocol, update, delete, Db-level
 * ops), so extending it is filling in the dispatch table, not new
 * plumbing.
 *
 * This process plays gateway and worker at once -- it holds a
 * TenantWorker directly and calls `open()` in-process. Splitting gateway
 * and worker into separate processes (the shape the docs describe for a
 * real multi-node deployment) means moving that call behind a network
 * hop; nothing else here should need to change to get there.
 *
 * `Collection.find()` now has a genuinely incremental/streaming path for
 * unsorted queries (a real WASM-side dc_cursor, bounded-memory on the
 * engine side -- see c/db.h's dc_cursor and src/binjson-wasm.js's
 * find()), so an unsorted cursor's HTTP pagination below is backed by
 * real resumable engine state, not an in-memory array sliced in JS. A
 * *sorted* query still has no choice but to materialize everything up
 * front -- an arbitrary in-memory sort fundamentally needs every match
 * before it can emit the first ordered result -- so that case still
 * pages through an already-fetched JS array, same as before. Both modes
 * present the identical wire protocol to clients; which one a given
 * cursor uses is an internal detail (`cursors` map entries carry a
 * `mode: 'stream' | 'array'` tag).
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as extjson from '../client/extended-json.js';
import { TenantUnavailableError } from './tenant-worker.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const DEFAULT_CURSOR_IDLE_MS = 60_000;
const DEFAULT_CURSOR_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

class HttpError extends Error {
  constructor(status, body) {
    const bodyObj = typeof body === 'string' ? { error: { message: body } } : body;
    super(bodyObj.error?.message ?? 'error');
    this.status = status;
    this.body = bodyObj;
  }
}

function createRestGateway({
  tenantWorker,
  tenantRegistry,
  cursorIdleMs = DEFAULT_CURSOR_IDLE_MS,
  cursorSweepIntervalMs = DEFAULT_CURSOR_SWEEP_INTERVAL_MS,
  requestRateLimiter = new TokenBucketRateLimiter()
}) {
  const cursors = new Map(); // cursorId -> { tenantKey, mode: 'stream'|'array', ...mode-specific state, expiresAt }

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of cursors) {
      if (now < entry.expiresAt) continue;
      cursors.delete(id);
      if (entry.mode === 'stream') {
        entry.cursor.close().catch((err) => console.error('[RestGateway] idle cursor cleanup failed:', err));
      }
    }
  }, cursorSweepIntervalMs);
  sweepTimer.unref?.();

  const routes = [
    { method: 'POST', pattern: '/v1/collections/:coll/insert-one', handler: handleInsertOne },
    { method: 'POST', pattern: '/v1/collections/:coll/find-one', handler: handleFindOne },
    { method: 'POST', pattern: '/v1/collections/:coll/find', handler: handleFind },
    { method: 'GET', pattern: '/v1/cursors/:cursorId/next', handler: handleCursorNext },
    { method: 'DELETE', pattern: '/v1/cursors/:cursorId', handler: handleCursorDelete },
    { method: 'POST', pattern: '/v1/collections/:coll/update-one', handler: handleUpdateOne },
    { method: 'POST', pattern: '/v1/collections/:coll/delete-one', handler: handleDeleteOne },
    { method: 'GET', pattern: '/v1/collections', handler: handleListCollections },
    { method: 'DELETE', pattern: '/v1/collections/:coll', handler: handleDropCollection }
  ].map(compileRoute);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[RestGateway] unhandled error:', err);
      if (!res.headersSent) writeJson(res, 500, { error: { message: 'internal error' } });
    });
  });
  server.on('close', () => clearInterval(sweepTimer));

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://internal');
    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) return writeJson(res, 404, { error: { message: 'not found' } });

    let tenantId;
    try {
      tenantId = await authenticate(req);
    } catch (err) {
      return writeJson(res, err.status ?? 401, err.body ?? { error: { message: 'unauthorized' } });
    }

    const rate = requestRateLimiter.tryConsume(tenantId);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return writeJson(res, 429, { error: { message: 'rate limit exceeded' } });
    }

    try {
      const body = await readJsonBody(req);
      await match.handler({ res, url, params: match.params, tenantId, body });
    } catch (err) {
      writeError(res, err);
    }
  }

  async function authenticate(req) {
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) throw new HttpError(401, 'missing bearer token');
    const tenantId = await tenantRegistry.resolveApiKey(m[1]);
    if (!tenantId) throw new HttpError(401, 'invalid API key');
    return tenantId;
  }

  async function getCollection(tenantId, collName) {
    const db = await tenantWorker.open(tenantId);
    return db.collection(collName);
  }

  async function handleInsertOne({ res, params, tenantId, body }) {
    if (!body.document) throw new HttpError(400, 'document is required');
    const coll = await getCollection(tenantId, params.coll);
    const result = await coll.insertOne(extjson.decode(body.document));
    writeJson(res, 200, extjson.encode({ insertedId: result.insertedId }));
  }

  async function handleFindOne({ res, params, tenantId, body }) {
    const coll = await getCollection(tenantId, params.coll);
    const doc = await coll.findOne(
      body.filter ? extjson.decode(body.filter) : {},
      body.projection ? { projection: body.projection } : {}
    );
    writeJson(res, 200, extjson.encode({ document: doc ?? null }));
  }

  /**
   * A sorted find() has no choice but to materialize everything up front
   * (see service/tenant-worker.js... no, see src/binjson-wasm.js's
   * find(): an arbitrary in-memory sort needs every match before it can
   * emit the first ordered result) -- so a sorted query pages through an
   * already-fetched JS array (mode: 'array'), same as this gateway always
   * did. An unsorted query now pages through the real WASM-backed
   * dc_cursor via Collection.find()'s cursor.next() (mode: 'stream') --
   * genuinely bounded-memory on the engine side, not just at this layer.
   */
  async function handleFind({ res, params, tenantId, body }) {
    const coll = await getCollection(tenantId, params.coll);
    const filter = body.filter ? extjson.decode(body.filter) : {};
    const options = {};
    if (body.sort) options.sort = body.sort;
    if (body.skip) options.skip = body.skip;
    if (body.limit) options.limit = body.limit;
    if (body.projection) options.projection = body.projection;
    const batchSize = clampBatchSize(body.batchSize);

    const cursor = coll.find(filter, options);
    if (body.sort) {
      const docs = await cursor.toArray();
      return respondWithArrayBatch(res, tenantId, docs, 0, batchSize);
    }
    await respondWithStreamBatch(res, tenantId, cursor, batchSize);
  }

  function respondWithArrayBatch(res, tenantId, docs, offset, batchSize) {
    const slice = docs.slice(offset, offset + batchSize);
    const nextOffset = offset + slice.length;
    if (nextOffset >= docs.length) {
      return writeJson(res, 200, extjson.encode({ batch: slice, cursorId: null }));
    }
    const cursorId = randomUUID();
    cursors.set(cursorId, {
      tenantKey: tenantId.toString(),
      mode: 'array',
      docs,
      offset: nextOffset,
      expiresAt: Date.now() + cursorIdleMs
    });
    writeJson(res, 200, extjson.encode({ batch: slice, cursorId }));
  }

  async function respondWithStreamBatch(res, tenantId, cursor, batchSize) {
    const { batch, done } = await pullStreamBatch(cursor, batchSize);
    if (done) {
      await cursor.close(); // usually already auto-closed on exhaustion inside find()'s cursor -- safe either way
      return writeJson(res, 200, extjson.encode({ batch, cursorId: null }));
    }
    const cursorId = randomUUID();
    cursors.set(cursorId, { tenantKey: tenantId.toString(), mode: 'stream', cursor, expiresAt: Date.now() + cursorIdleMs });
    writeJson(res, 200, extjson.encode({ batch, cursorId }));
  }

  /** Pulls up to batchSize documents one at a time off a real find() cursor -- see its own internal 100-doc WASM-level batching, decoupled from this HTTP-level batchSize. */
  async function pullStreamBatch(cursor, batchSize) {
    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      const { value, done } = await cursor.next();
      if (done) return { batch, done: true };
      batch.push(value);
    }
    return { batch, done: false };
  }

  async function handleCursorNext({ res, url, params, tenantId }) {
    const entry = cursors.get(params.cursorId);
    if (!entry || entry.tenantKey !== tenantId.toString()) {
      throw new HttpError(404, { error: { code: 43, codeName: 'CursorNotFound', message: 'cursor not found or expired' } });
    }
    tenantWorker.touch(tenantId); // an in-progress cursor is activity, even with no new open() calls
    const batchSize = clampBatchSize(Number(url.searchParams.get('batchSize')));

    if (entry.mode === 'array') {
      const slice = entry.docs.slice(entry.offset, entry.offset + batchSize);
      entry.offset += slice.length;
      if (entry.offset >= entry.docs.length) {
        cursors.delete(params.cursorId);
        return writeJson(res, 200, extjson.encode({ batch: slice, cursorId: null }));
      }
      entry.expiresAt = Date.now() + cursorIdleMs;
      return writeJson(res, 200, extjson.encode({ batch: slice, cursorId: params.cursorId }));
    }

    const { batch, done } = await pullStreamBatch(entry.cursor, batchSize);
    if (done) {
      cursors.delete(params.cursorId);
      await entry.cursor.close();
      return writeJson(res, 200, extjson.encode({ batch, cursorId: null }));
    }
    entry.expiresAt = Date.now() + cursorIdleMs;
    writeJson(res, 200, extjson.encode({ batch, cursorId: params.cursorId }));
  }

  async function handleCursorDelete({ res, params, tenantId }) {
    const entry = cursors.get(params.cursorId);
    if (entry && entry.tenantKey === tenantId.toString()) {
      cursors.delete(params.cursorId);
      if (entry.mode === 'stream') await entry.cursor.close();
    }
    res.writeHead(204).end();
  }

  async function handleUpdateOne({ res, params, tenantId, body }) {
    if (!body.filter || !body.update) throw new HttpError(400, 'filter and update are required');
    const coll = await getCollection(tenantId, params.coll);
    const result = await coll.updateOne(extjson.decode(body.filter), extjson.decode(body.update), {
      upsert: !!body.upsert
    });
    writeJson(res, 200, extjson.encode(result));
  }

  async function handleDeleteOne({ res, params, tenantId, body }) {
    const coll = await getCollection(tenantId, params.coll);
    const result = await coll.deleteOne(body.filter ? extjson.decode(body.filter) : {});
    writeJson(res, 200, extjson.encode(result));
  }

  async function handleListCollections({ res, tenantId }) {
    const db = await tenantWorker.open(tenantId);
    writeJson(res, 200, { collections: await db.listCollections() });
  }

  async function handleDropCollection({ res, params, tenantId }) {
    const db = await tenantWorker.open(tenantId);
    await db.dropCollection(params.coll);
    res.writeHead(204).end();
  }

  function writeError(res, err) {
    if (err instanceof HttpError) return writeJson(res, err.status, err.body);
    if (err instanceof TenantUnavailableError) {
      res.setHeader('Retry-After', '1');
      return writeJson(res, 503, { error: { message: err.message } });
    }
    if (err instanceof Error && /Duplicate _id|Duplicate key/.test(err.message)) {
      return writeJson(res, 409, { error: { code: 11000, codeName: 'DuplicateKey', message: err.message } });
    }
    console.error('[RestGateway] handler error:', err);
    writeJson(res, 500, { error: { message: 'internal error' } });
  }

  return server;
}

function compileRoute({ method, pattern, handler }) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, regex: new RegExp(`^${regexStr}$`), paramNames, handler };
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    return { handler: route.handler, params };
  }
  return null;
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'malformed JSON body');
  }
}

function writeJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function clampBatchSize(n) {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(n, MAX_BATCH_SIZE);
}

export { createRestGateway, HttpError };
