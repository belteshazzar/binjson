/**
 * service/websocket-gateway.js — implements docs/cloud-websocket-api.md
 * against a TenantWorker: the one channel that carries watch() change
 * events, multiplexing every subscription one client holds over a single
 * connection. Attaches to an existing http.Server (the same one
 * service/rest-gateway.js listens on) at `/v1/stream`, rather than
 * running its own port -- one origin serving both, matching the doc's
 * `wss://api.yourapp.com/v1/stream` URL.
 *
 * Built on the `ws` package -- hand-rolling RFC 6455 framing (masking,
 * fragmentation, ping/pong control frames) is exactly the kind of
 * protocol-correctness work not worth redoing, and `ws` is pure JS (no
 * native build step, unlike fs-ext's flock binding).
 *
 * Does not import or depend on TenantWorker directly -- `onTenantClosing`
 * is returned to the caller to wire up (`tenantWorker.onTenantClosing =
 * gateway.onTenantClosing`), keeping the composition explicit at whoever
 * assembles the full server rather than reaching into a dependency.
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import * as extjson from '../client/extended-json.js';
import { PerTenantLimitCounter } from './rate-limiter.js';

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS_PER_TENANT = 10;
const DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT = 100;

function attachWebSocketGateway(
  httpServer,
  {
    tenantWorker,
    tenantRegistry,
    path = '/v1/stream',
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    connectionLimiter = new PerTenantLimitCounter(DEFAULT_MAX_CONNECTIONS_PER_TENANT),
    subscriptionLimiter = new PerTenantLimitCounter(DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT)
  }
) {
  const wss = new WebSocketServer({ server: httpServer, path });
  const connectionsByTenant = new Map(); // tenantKey -> Set<ConnState>

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function cleanupConnection(state) {
    clearTimeout(state.authTimeout);
    clearTimeout(state.pongDeadline);
    clearInterval(state.heartbeatInterval);
    for (const stream of state.subscriptions.values()) {
      stream.close();
      subscriptionLimiter.release(state.tenantId);
    }
    state.subscriptions.clear();
    if (state.tenantKey) connectionsByTenant.get(state.tenantKey)?.delete(state);
    if (state.connectionAcquired) {
      connectionLimiter.release(state.tenantId);
      state.connectionAcquired = false;
    }
  }

  function closeConn(state, code, reason) {
    cleanupConnection(state);
    try {
      state.ws.close(code, reason);
    } catch {
      /* already closed/closing -- nothing further to do */
    }
  }

  function startHeartbeat(state) {
    state.heartbeatInterval = setInterval(() => {
      send(state.ws, { type: 'ping' });
      state.pongDeadline = setTimeout(() => closeConn(state, 1001, 'heartbeat timeout'), heartbeatTimeoutMs);
    }, heartbeatIntervalMs);
    state.heartbeatInterval.unref?.();
  }

  async function handleAuth(state, msg) {
    clearTimeout(state.authTimeout);
    const tenantId = typeof msg.apiKey === 'string' ? await tenantRegistry.resolveApiKey(msg.apiKey) : null;
    if (!tenantId) return closeConn(state, 4401, 'invalid API key');

    // Set before the connection-cap check so cleanupConnection (invoked by
    // closeConn below) can find this state in connectionsByTenant and tear
    // it down consistently either way -- a rejected connection still needs
    // the same bookkeeping cleaned up, not a special-cased skip.
    state.tenantId = tenantId;
    state.tenantKey = tenantId.toString();

    if (!connectionLimiter.tryAcquire(tenantId)) {
      return closeConn(state, 4429, 'too many connections for this tenant');
    }
    state.connectionAcquired = true;
    state.authenticated = true;

    if (!connectionsByTenant.has(state.tenantKey)) connectionsByTenant.set(state.tenantKey, new Set());
    connectionsByTenant.get(state.tenantKey).add(state);

    send(state.ws, { type: 'authAck' });
    startHeartbeat(state);
  }

  function deliverChange(state, subscriptionId, event) {
    if (state.ws.bufferedAmount > maxBufferedBytes) {
      return closeConn(state, 4413, 'slow consumer');
    }
    send(state.ws, { type: 'change', subscriptionId, event: extjson.encode(event) });
  }

  async function handleSubscribe(state, msg) {
    if (msg.pipeline && msg.pipeline.length) {
      return send(state.ws, {
        type: 'subscribeError',
        requestId: msg.requestId,
        error: { message: 'pipeline stages are not supported yet' }
      });
    }
    if (typeof msg.collection !== 'string' || !msg.collection) {
      return send(state.ws, { type: 'subscribeError', requestId: msg.requestId, error: { message: 'collection is required' } });
    }
    // A subscription-count cap is a subscription-level problem, not a
    // connection-level one -- subscribeError, not a close (4429 is
    // reserved for the connection-count cap in handleAuth, matching this
    // doc's own principle that bad individual subscribe calls shouldn't
    // take down every other subscription multiplexed on the same socket).
    if (!subscriptionLimiter.tryAcquire(state.tenantId)) {
      return send(state.ws, {
        type: 'subscribeError',
        requestId: msg.requestId,
        error: { message: 'too many subscriptions for this tenant' }
      });
    }

    tenantWorker.touch(state.tenantId);
    let db;
    try {
      db = await tenantWorker.open(state.tenantId);
    } catch (err) {
      subscriptionLimiter.release(state.tenantId); // didn't end up subscribing -- give the slot back
      return send(state.ws, { type: 'subscribeError', requestId: msg.requestId, error: { message: err.message } });
    }

    let stream;
    try {
      stream = (await db.collection(msg.collection)).watch();
    } catch (err) {
      subscriptionLimiter.release(state.tenantId);
      return send(state.ws, { type: 'subscribeError', requestId: msg.requestId, error: { message: err.message } });
    }

    const subscriptionId = randomUUID();
    stream.on('change', (event) => deliverChange(state, subscriptionId, event));
    state.subscriptions.set(subscriptionId, stream);

    send(state.ws, { type: 'subscribed', requestId: msg.requestId, subscriptionId });
  }

  function handleUnsubscribe(state, msg) {
    const stream = state.subscriptions.get(msg.subscriptionId);
    if (stream) {
      stream.close();
      state.subscriptions.delete(msg.subscriptionId);
      subscriptionLimiter.release(state.tenantId);
    }
    send(state.ws, { type: 'unsubscribed', subscriptionId: msg.subscriptionId });
  }

  async function handleMessage(state, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed frame -- ignore rather than tear down a multiplexed connection over one bad message
    }

    if (!state.authenticated) {
      if (msg.type !== 'auth') return closeConn(state, 4401, 'expected auth as the first message');
      return handleAuth(state, msg);
    }

    tenantWorker.touch(state.tenantId); // any message on an authenticated connection counts as activity

    switch (msg.type) {
      case 'subscribe':
        return handleSubscribe(state, msg);
      case 'unsubscribe':
        return handleUnsubscribe(state, msg);
      case 'ping':
        return send(state.ws, { type: 'pong' });
      case 'pong':
        clearTimeout(state.pongDeadline);
        return;
      default:
        return send(state.ws, { type: 'error', message: `unrecognized message type "${msg.type}"` });
    }
  }

  wss.on('connection', (ws) => {
    const state = {
      ws,
      authenticated: false,
      tenantId: null,
      tenantKey: null,
      subscriptions: new Map(), // subscriptionId -> ChangeStream
      heartbeatInterval: null,
      pongDeadline: null,
      authTimeout: setTimeout(() => closeConn(state, 4401, 'auth timeout'), authTimeoutMs)
    };

    ws.on('message', (data) => {
      handleMessage(state, data).catch((err) => console.error('[WsGateway] message handling failed:', err));
    });
    ws.on('close', () => cleanupConnection(state));
    ws.on('error', (err) => console.error('[WsGateway] connection error:', err));
  });

  /**
   * Call just before a tenant's Db closes (wire up as
   * `tenantWorker.onTenantClosing = gateway.onTenantClosing`) -- every
   * open subscription for that tenant closes with 4409, matching
   * docs/cloud-websocket-api.md's "Tenant migration mid-subscription":
   * boring by design, since watch() already has no resume guarantee, a
   * lease handoff is just an ordinary reconnect from the client's view.
   */
  function onTenantClosing(tenantId) {
    const key = tenantId.toString();
    const conns = connectionsByTenant.get(key);
    if (!conns) return;
    for (const state of [...conns]) closeConn(state, 4409, 'tenant lease revoked/migrated');
    connectionsByTenant.delete(key);
  }

  return { wss, onTenantClosing };
}

export { attachWebSocketGateway };
