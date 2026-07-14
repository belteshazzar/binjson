/**
 * Server-side WebSocket gateway tests, driven with the raw global
 * WebSocket against a real listening server (REST gateway + WS gateway
 * on the same http.Server, same as a real deployment) -- proving the
 * wire protocol in docs/cloud-websocket-api.md directly, independent of
 * the client shim (test/client-e2e.test.js covers the shim itself).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ready } from '../src/binjson-wasm.js';
import { MemoryStorageProvider } from '../src/db.js';
import { openControlPlane } from '../service/control-plane.js';
import { TenantWorker } from '../service/tenant-worker.js';
import { createRestGateway } from '../service/rest-gateway.js';
import { attachWebSocketGateway } from '../service/websocket-gateway.js';
import { PerTenantLimitCounter } from '../service/rate-limiter.js';

await ready();

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup(wsOptions = {}) {
  const controlPlane = await openControlPlane({ provider: new MemoryStorageProvider() });
  const { tenantId, apiKey } = await controlPlane.tenantRegistry.createTenant();
  await controlPlane.leaseStore.provisionTenant(tenantId);

  const tenantWorker = new TenantWorker({
    leaseStore: controlPlane.leaseStore,
    workerId: 'worker-a',
    createProvider: () => new MemoryStorageProvider(),
    ttlMs: 30_000
  });

  const server = createRestGateway({ tenantWorker, tenantRegistry: controlPlane.tenantRegistry });
  const { wss, onTenantClosing } = attachWebSocketGateway(server, {
    tenantWorker,
    tenantRegistry: controlPlane.tenantRegistry,
    authTimeoutMs: 300,
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 100,
    ...wsOptions
  });
  tenantWorker.onTenantClosing = onTenantClosing;

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/stream`;

  cleanups.push(async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await tenantWorker.closeAll();
    await controlPlane.close();
  });

  return { baseUrl, wsUrl, apiKey, tenantId, tenantWorker, controlPlane };
}

/** A small promise-friendly wrapper over the raw WebSocket for sequential protocol testing. */
function wsClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const queue = [];
  const waiters = [];
  let closeInfo = null;
  const closed = new Promise((resolve) => {
    ws.addEventListener('close', (event) => {
      closeInfo = { code: event.code, reason: event.reason };
      resolve(closeInfo);
    });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });

  return {
    ws,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    async nextOrTimeout(ms) {
      return Promise.race([this.next(), new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms))]);
    },
    closed,
    get closeInfo() {
      return closeInfo;
    },
    waitOpen() {
      return new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
    }
  };
}

describe('WebSocket gateway (real WS, driving the wire protocol directly)', () => {
  it('authenticates with a valid API key and gets authAck', async () => {
    const { wsUrl, apiKey } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    expect(await c.next()).toEqual({ type: 'authAck' });
    c.ws.close();
  });

  it('closes with 4401 for an invalid API key', async () => {
    const { wsUrl } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey: 'sk_not-real' });
    const info = await c.closed;
    expect(info.code).toBe(4401);
  });

  it('closes with 4401 if the first message is not auth', async () => {
    const { wsUrl } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'subscribe', requestId: '1', collection: 'items' });
    const info = await c.closed;
    expect(info.code).toBe(4401);
  });

  it('closes with 4401 if no auth message arrives within authTimeoutMs', async () => {
    const { wsUrl } = await setup({ authTimeoutMs: 100 });
    const c = wsClient(wsUrl);
    await c.waitOpen();
    const info = await c.closed;
    expect(info.code).toBe(4401);
  });

  it('subscribes and receives a change event for a real insert made over REST', async () => {
    const { wsUrl, baseUrl, apiKey } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next(); // authAck

    c.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [] });
    const subAck = await c.next();
    expect(subAck.type).toBe('subscribed');
    expect(subAck.requestId).toBe('r1');
    expect(typeof subAck.subscriptionId).toBe('string');

    await fetch(`${baseUrl}/v1/collections/items/insert-one`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { name: 'Ada' } })
    });

    const change = await c.next();
    expect(change.type).toBe('change');
    expect(change.subscriptionId).toBe(subAck.subscriptionId);
    expect(change.event.operationType).toBe('insert');
    expect(change.event.ns).toEqual({ coll: 'items' });
    expect(change.event.fullDocument.name).toBe('Ada');
    c.ws.close();
  });

  it('subscribeError for a non-empty pipeline, connection stays open', async () => {
    const { wsUrl, apiKey } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();

    c.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [{ $match: {} }] });
    const res = await c.next();
    expect(res.type).toBe('subscribeError');
    expect(res.requestId).toBe('r1');

    // Still usable afterward -- one bad subscribe doesn't kill the connection.
    c.send({ type: 'ping' });
    expect(await c.next()).toEqual({ type: 'pong' });
    c.ws.close();
  });

  it('unsubscribe stops further change delivery for that subscription', async () => {
    // A longer heartbeat interval than the "nothing arrived" wait below, so a routine ping doesn't race the assertion.
    const { wsUrl, baseUrl, apiKey } = await setup({ heartbeatIntervalMs: 10_000 });
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();
    c.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [] });
    const { subscriptionId } = await c.next();

    c.send({ type: 'unsubscribe', subscriptionId });
    expect(await c.next()).toEqual({ type: 'unsubscribed', subscriptionId });

    await fetch(`${baseUrl}/v1/collections/items/insert-one`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { name: 'Grace' } })
    });

    expect(await c.nextOrTimeout(200)).toBe('__timeout__');
    c.ws.close();
  });

  it('closes every subscription for a tenant with 4409 when its lease is released', async () => {
    const { wsUrl, apiKey, tenantId, tenantWorker } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();
    c.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [] });
    await c.next(); // subscribed

    await tenantWorker.release(tenantId);

    const info = await c.closed;
    expect(info.code).toBe(4409);
  });

  it('two different tenants do not see each other\'s change events, even on the same collection name', async () => {
    const a = await setup({ heartbeatIntervalMs: 10_000 });
    const b = await setup();

    const ca = wsClient(a.wsUrl);
    await ca.waitOpen();
    ca.send({ type: 'auth', apiKey: a.apiKey });
    await ca.next();
    ca.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [] });
    await ca.next();

    await fetch(`${b.baseUrl}/v1/collections/items/insert-one`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { name: 'from tenant B' } })
    });

    expect(await ca.nextOrTimeout(200)).toBe('__timeout__');
    ca.ws.close();
  });

  it('responds to server-initiated heartbeat pings, and closes with 1001 if the client never answers', async () => {
    const { wsUrl, apiKey } = await setup({ heartbeatIntervalMs: 80, heartbeatTimeoutMs: 80 });
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();

    const ping = await c.next();
    expect(ping).toEqual({ type: 'ping' });
    // Never reply -- the server's pong deadline should close the connection.
    const info = await c.closed;
    expect(info.code).toBe(1001);
  });

  it('replying to heartbeat pings keeps the connection alive past what would otherwise be the timeout', async () => {
    const { wsUrl, apiKey } = await setup({ heartbeatIntervalMs: 60, heartbeatTimeoutMs: 60 });
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();

    for (let i = 0; i < 3; i++) {
      const ping = await c.next();
      expect(ping.type).toBe('ping');
      c.send({ type: 'pong' });
    }
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('a malformed frame is ignored, not fatal to the connection', async () => {
    const { wsUrl, apiKey } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.ws.send('not json{{{');
    c.send({ type: 'auth', apiKey });
    expect(await c.next()).toEqual({ type: 'authAck' });
    c.ws.close();
  });

  it('an unrecognized message type gets an error response, not a connection close', async () => {
    const { wsUrl, apiKey } = await setup();
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();
    c.send({ type: 'not-a-real-type' });
    const res = await c.next();
    expect(res.type).toBe('error');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('closes with 4429 once a tenant exceeds its connection cap', async () => {
    const { wsUrl, apiKey } = await setup({ connectionLimiter: new PerTenantLimitCounter(1) });

    const first = wsClient(wsUrl);
    await first.waitOpen();
    first.send({ type: 'auth', apiKey });
    expect(await first.next()).toEqual({ type: 'authAck' });

    const second = wsClient(wsUrl);
    await second.waitOpen();
    second.send({ type: 'auth', apiKey });
    const info = await second.closed;
    expect(info.code).toBe(4429);

    first.ws.close();
  });

  it('a released connection frees its slot for a new one', async () => {
    const { wsUrl, apiKey } = await setup({ connectionLimiter: new PerTenantLimitCounter(1) });

    const first = wsClient(wsUrl);
    await first.waitOpen();
    first.send({ type: 'auth', apiKey });
    await first.next();
    first.ws.close();
    await first.closed;

    const second = wsClient(wsUrl);
    await second.waitOpen();
    second.send({ type: 'auth', apiKey });
    expect(await second.next()).toEqual({ type: 'authAck' });
    second.ws.close();
  });

  it('subscribeError (not a connection close) once a tenant exceeds its subscription cap', async () => {
    const { wsUrl, apiKey } = await setup({ subscriptionLimiter: new PerTenantLimitCounter(1) });
    const c = wsClient(wsUrl);
    await c.waitOpen();
    c.send({ type: 'auth', apiKey });
    await c.next();

    c.send({ type: 'subscribe', requestId: 'r1', collection: 'items', pipeline: [] });
    const first = await c.next();
    expect(first.type).toBe('subscribed');

    c.send({ type: 'subscribe', requestId: 'r2', collection: 'other', pipeline: [] });
    const second = await c.next();
    expect(second.type).toBe('subscribeError');
    expect(second.requestId).toBe('r2');
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // rejected subscription, not a torn-down connection

    // Freeing the one held subscription allows a new one through.
    c.send({ type: 'unsubscribe', subscriptionId: first.subscriptionId });
    await c.next(); // unsubscribed
    c.send({ type: 'subscribe', requestId: 'r3', collection: 'other', pipeline: [] });
    const third = await c.next();
    expect(third.type).toBe('subscribed');
    c.ws.close();
  });
});
