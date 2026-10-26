// HTTP binding for the connector contract (Kimi-owned).
//
// createHttpServer({ connector, authenticate, knocket? }) returns an
// UNSTARTED Node http.Server; the host binds it (the coordinator CLI binds
// loopback). authenticate(req) is a host callback returning a verified
// identity { principal, endUserRef? } or denying by throwing / returning a
// falsy value. Identity NEVER comes from request bodies.
//
// Routes:
//   GET  /v1/connections/:id            -> connector.describe
//   POST /v1/connections/:id/tasks      -> connector.submit
//   GET  /v1/tasks/:handle              -> connector.get
//   POST /v1/tasks/:handle/cancel       -> connector.cancel   (body exactly {})
//   POST /v1/chat/completions           -> knocket handler, when configured
//
// Success responses are the descriptor/snapshot JSON with status 200.
// Error responses are { error: publicError(error) } with the status from
// errors.mjs. Request bodies are bounded by LIMITS.bodyBytes; JSON bodies
// must use content-type application/json; unknown routes and wrong methods
// -> 404; unknown body fields -> 400. No CORS headers are emitted.
import http from 'node:http';
import { publicError, ConnectorError, LIMITS } from '../../contract.mjs';
import { readBoundedBody, parseJsonBody } from './body.mjs';
import { httpStatusForError, errorHeaders } from './errors.mjs';
import {
  validateIdentity,
  validateConnectionId,
  validateHandle,
  validateInvocation,
  assertNoExtraFields,
} from '../common/validate.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';

function writeJson(res, status, value, extraHeaders) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function writeError(res, error, { connectionClose = false } = {}) {
  if (res.writableEnded || res.destroyed) return;
  const safe = error instanceof ConnectorError ? error : new ConnectorError('STATE_UNAVAILABLE');
  writeJson(
    res,
    httpStatusForError(safe),
    { error: publicError(safe) },
    connectionClose ? { connection: 'close' } : errorHeaders(safe),
  );
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
}

// Authentication backends fail closed: a host authenticate() that throws a
// non-connector error means the caller is unauthenticated, never an
// automatic pass (contract A08: identity service unavailable -> deny).
async function authenticateCaller(authenticate, req) {
  try {
    return await authenticate(req);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('UNAUTHENTICATED');
  }
}

function matchRoute(pathname) {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  if (segments[0] !== 'v1' || segments.length < 2) return undefined;
  if (segments.length === 3 && segments[1] === 'connections') {
    return { op: 'describe', connectionId: decodeSegment(segments[2]) };
  }
  if (segments.length === 4 && segments[1] === 'connections' && segments[3] === 'tasks') {
    return { op: 'submit', connectionId: decodeSegment(segments[2]) };
  }
  if (segments.length === 3 && segments[1] === 'tasks') {
    return { op: 'get', handle: decodeSegment(segments[2]) };
  }
  if (segments.length === 4 && segments[1] === 'tasks' && segments[3] === 'cancel') {
    return { op: 'cancel', handle: decodeSegment(segments[2]) };
  }
  if (segments.length === 3 && segments[1] === 'chat' && segments[2] === 'completions') {
    return { op: 'knocket' };
  }
  return undefined;
}

function allowedMethods(route) {
  switch (route.op) {
    case 'describe':
    case 'get': return 'GET';
    case 'submit':
    case 'cancel':
    case 'knocket': return 'POST';
    default: return 'GET, POST';
  }
}

async function readJsonRequest(req) {
  const declared = req.headers['content-type'];
  const mediaType = typeof declared === 'string' ? declared.split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  const body = await readBoundedBody(req, LIMITS.bodyBytes);
  return parseJsonBody(body);
}

export function createHttpServer({ connector, authenticate, knocket } = {}) {
  if (!connector || typeof connector !== 'object') throw new TypeError('connector service is required');
  if (typeof authenticate !== 'function') throw new TypeError('authenticate(req) callback is required');

  const server = http.createServer(async (req, res) => {
    try {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://connector.local').pathname;
      } catch {
        throw new ConnectorError('INVALID_ARGUMENT');
      }
      const route = matchRoute(pathname);
      if (!route) {
        req.resume();
        throw new ConnectorError('NOT_FOUND');
      }
      if (route.op === 'knocket') {
        if (req.method !== 'POST') {
          req.resume();
          throw new ConnectorError('NOT_FOUND');
        }
        if (typeof knocket !== 'function') throw new ConnectorError('NOT_FOUND');
        const identity = validateIdentity(await authenticateCaller(authenticate, req));
        await knocket(req, res, identity);
        return;
      }
      if (req.method !== allowedMethods(route)) {
        req.resume();
        throw new ConnectorError('NOT_FOUND');
      }

      const identity = validateIdentity(await authenticateCaller(authenticate, req));

      if (route.op === 'describe') {
        req.resume();
        const descriptor = await connector.describe(identity, validateConnectionId(route.connectionId));
        writeJson(res, 200, descriptor);
        return;
      }
      if (route.op === 'get') {
        req.resume();
        const snapshot = await connector.get(identity, validateHandle(route.handle));
        writeJson(res, 200, snapshot);
        return;
      }
      const body = await readJsonRequest(req);
      if (route.op === 'submit') {
        const invocation = validateInvocation(body);
        const snapshot = await connector.submit(identity, validateConnectionId(route.connectionId), invocation);
        writeJson(res, 200, snapshot);
        return;
      }
      // route.op === 'cancel'
      assertNoExtraFields(body, []);
      const snapshot = await connector.cancel(identity, validateHandle(route.handle));
      writeJson(res, 200, snapshot);
    } catch (error) {
      if (error && error.excessiveBody === true) {
        // Abusive request body: structured 400 + Connection: close, then
        // destroy the socket only after the response has been flushed.
        writeError(res, error, { connectionClose: true });
        const socket = req.socket ?? res.socket;
        if (socket) {
          const teardown = () => socket.destroy();
          if (res.writableEnded) teardown();
          else {
            res.once('finish', teardown);
            res.once('close', teardown);
          }
        }
        return;
      }
      writeError(res, error);
    }
  });

  // Hard bounds so slow clients cannot hold connections forever: headers
  // must arrive within 10s, the whole request (including body) within 30s.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;

  // Malformed requests get the same structured INVALID_ARGUMENT document as
  // every other route instead of Node's default HTML error page.
  server.on('clientError', (error, socket) => {
    void error;
    if (socket.writable && !socket.destroyed) {
      const document = JSON.stringify({ error: publicError(new ConnectorError('INVALID_ARGUMENT')) });
      socket.end(
        'HTTP/1.1 400 Bad Request\r\n' +
          'content-type: application/json; charset=utf-8\r\n' +
          `content-length: ${Buffer.byteLength(document)}\r\n` +
          'connection: close\r\n' +
          '\r\n' +
          document,
      );
    } else {
      socket.destroy();
    }
  });

  return server;
}
