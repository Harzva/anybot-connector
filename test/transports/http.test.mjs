// Black-box tests for the HTTP binding against an independent synthetic
// connector service (no core, no real provider). Loopback ephemeral ports
// only; every world is closed in finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { LIMITS, publicError, ConnectorError } from '../../src/contract.mjs';
import { startHttpWorld, sleep } from './test-utils.mjs';

const CONN = 'conn-demo';

test('GET /v1/connections/:id returns the capability descriptor', async () => {
  const world = await startHttpWorld();
  try {
    const { status, body } = await world.request('GET', `/v1/connections/${CONN}`);
    assert.equal(status, 200);
    assert.equal(body.contractVersion, 'anybot.connector/0.1');
    assert.deepEqual(body.operations, ['describe', 'submit', 'get', 'cancel']);
    assert.deepEqual(body.input, { text: true, attachments: false });
    assert.deepEqual(body.output, { text: true, tokenStreaming: false });
    assert.equal(body.humanHandoff, false);
    assert.equal(body.publication, 'support-demo');
  } finally {
    await world.close();
  }
});

test('POST submit returns a snapshot; missing key and conversation get defaults', async () => {
  const world = await startHttpWorld();
  try {
    const { status, body } = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'What are your support hours?' } },
    });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['handle', 'observedAt', 'requestKey', 'state']);
    assert.equal(body.state, 'accepted');
    assert.equal(typeof body.handle, 'string');
    assert.match(body.requestKey, /^[0-9a-f-]{36}$/);

    const got = await world.request('GET', `/v1/tasks/${encodeURIComponent(body.handle)}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.handle, body.handle);
    assert.equal(got.body.requestKey, body.requestKey);
  } finally {
    await world.close();
  }
});

test('explicit requestKey/conversationRef are honored; succeeded result carries text', async () => {
  const world = await startHttpWorld({ provider: { delayMs: 10 } });
  try {
    const { status, body } = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: {
        requestKey: 'req-ABC_1:2',
        conversationRef: 'conv-1.2_3:4',
        input: { type: 'text', text: 'hello' },
      },
    });
    assert.equal(status, 200);
    assert.equal(body.requestKey, 'req-ABC_1:2');
    await sleep(60);
    const got = await world.request('GET', `/v1/tasks/${encodeURIComponent(body.handle)}`);
    assert.equal(got.body.state, 'succeeded');
    assert.equal(got.body.result.type, 'text');
    assert.match(got.body.result.text, /^\[synthetic-provider\] hello$/);
  } finally {
    await world.close();
  }
});

test('same key + same payload returns the same task with one upstream effect', async () => {
  const world = await startHttpWorld();
  try {
    const payload = { requestKey: 'req-same', input: { type: 'text', text: 'repeatable' } };
    const first = await world.request('POST', `/v1/connections/${CONN}/tasks`, { body: payload });
    const second = await world.request('POST', `/v1/connections/${CONN}/tasks`, { body: payload });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.handle, first.body.handle);
    assert.equal(world.provider.submitCount(), 1);
  } finally {
    await world.close();
  }
});

test('same key + different payload -> 409 IDEMPOTENCY_CONFLICT with public error shape', async () => {
  const world = await startHttpWorld();
  try {
    const first = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { requestKey: 'req-conflict', input: { type: 'text', text: 'original' } },
    });
    assert.equal(first.status, 200);
    const conflict = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { requestKey: 'req-conflict', input: { type: 'text', text: 'changed' } },
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: publicError(new ConnectorError('IDEMPOTENCY_CONFLICT')) });
    // The original task is untouched.
    const got = await world.request('GET', `/v1/tasks/${encodeURIComponent(first.body.handle)}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.requestKey, 'req-conflict');
  } finally {
    await world.close();
  }
});

test('concurrent same-key submissions produce exactly one upstream effect', async () => {
  const world = await startHttpWorld({ provider: { delayMs: 25 } });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      world.request('POST', `/v1/connections/${CONN}/tasks`, {
        body: { requestKey: 'req-race', input: { type: 'text', text: 'once only' } },
      }),
    ));
    const handles = new Set(results.map((r) => r.body?.handle));
    assert.equal(handles.size, 1);
    assert.equal(world.provider.submitCount(), 1);
  } finally {
    await world.close();
  }
});

test('unknown fields, wrong input type, empty/oversize text, bad refs -> 400', async () => {
  const world = await startHttpWorld();
  try {
    const cases = [
      { input: { type: 'text', text: 'ok' }, extra: true },
      { input: { type: 'text', text: 'ok', nested: 1 } },
      { input: { type: 'image', text: 'ok' } },
      { input: { type: 'text', text: '' } },
      { input: { type: 'text', text: 'é'.repeat(LIMITS.textBytes) } },
      { requestKey: 'bad key!', input: { type: 'text', text: 'ok' } },
      { requestKey: 'x'.repeat(129), input: { type: 'text', text: 'ok' } },
      { conversationRef: 'a'.repeat(129), input: { type: 'text', text: 'ok' } },
      { input: 'not-an-object' },
      'not-an-object',
    ];
    for (const body of cases) {
      const res = await world.request('POST', `/v1/connections/${CONN}/tasks`, { body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message', 'retryable']);
    }
  } finally {
    await world.close();
  }
});

test('oversize request body is rejected without reading it all', async () => {
  const world = await startHttpWorld();
  try {
    const huge = { input: { type: 'text', text: 'x'.repeat(LIMITS.bodyBytes + 16) } };
    const res = await world.request('POST', `/v1/connections/${CONN}/tasks`, { body: huge });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_ARGUMENT');
  } finally {
    await world.close();
  }
});

test('malformed JSON and non-JSON content type are rejected', async () => {
  const world = await startHttpWorld();
  try {
    const res = await fetch(`${world.base}/v1/connections/${CONN}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: '{"input":',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_ARGUMENT');

    const res2 = await fetch(`${world.base}/v1/connections/${CONN}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-test-user': 'alice' },
      body: 'hello',
    });
    assert.equal(res2.status, 400);
    assert.equal((await res2.json()).error.code, 'INVALID_ARGUMENT');
  } finally {
    await world.close();
  }
});

test('unknown connection and guessed handles -> 404 NOT_FOUND', async () => {
  const world = await startHttpWorld();
  try {
    const unknown = await world.request('GET', '/v1/connections/conn-nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    const guessed = await world.request('GET', `/v1/tasks/${encodeURIComponent('h_guessed-handle-000')}`);
    assert.equal(guessed.status, 404);
    assert.deepEqual(guessed.body, { error: publicError(new ConnectorError('NOT_FOUND')) });
  } finally {
    await world.close();
  }
});

test('identities are isolated by principal and endUserRef', async () => {
  const world = await startHttpWorld();
  try {
    const mine = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'private' } },
      headers: { 'x-test-user': 'alice', 'x-test-visitor': 'visitor-1' },
    });
    assert.equal(mine.status, 200);
    const handle = encodeURIComponent(mine.body.handle);

    // Different principal.
    const other = await world.request('GET', `/v1/tasks/${handle}`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(other.status, 404);
    assert.equal(other.body.error.code, 'NOT_FOUND');

    // Same principal, different endUserRef.
    const otherVisitor = await world.request('GET', `/v1/tasks/${handle}`, {
      headers: { 'x-test-user': 'alice', 'x-test-visitor': 'visitor-2' },
    });
    assert.equal(otherVisitor.status, 404);

    // Same principal, same endUserRef -> visible.
    const same = await world.request('GET', `/v1/tasks/${handle}`, {
      headers: { 'x-test-user': 'alice', 'x-test-visitor': 'visitor-1' },
    });
    assert.equal(same.status, 200);

    // Guessed cancel by another identity is also NOT_FOUND (not forbidden).
    const cancel = await world.request('POST', `/v1/tasks/${handle}/cancel`, {
      body: {},
      headers: { 'x-test-user': 'bob' },
    });
    assert.equal(cancel.status, 404);
  } finally {
    await world.close();
  }
});

test('unauthenticated callers are rejected with 401', async () => {
  const world = await startHttpWorld();
  try {
    const res = await world.request('GET', `/v1/connections/${CONN}`, { headers: { 'x-test-user': 'nobody' } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');

    const broken = await world.request('GET', `/v1/connections/${CONN}`, { headers: { 'x-test-user': 'broken' } });
    assert.equal(broken.status, 401);
    assert.equal(broken.body.error.code, 'UNAUTHENTICATED');
  } finally {
    await world.close();
  }
});

test('authorize denial maps to 403 FORBIDDEN', async () => {
  const world = await startHttpWorld({
    authorize: async ({ operation, identity }) => identity.principal !== 'mallory' || operation === 'describe',
  });
  try {
    const described = await world.request('GET', `/v1/connections/${CONN}`, { headers: { 'x-test-user': 'mallory' } });
    assert.equal(described.status, 200);
    const denied = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'nope' } },
      headers: { 'x-test-user': 'mallory' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  } finally {
    await world.close();
  }
});

test('cancel requires an empty JSON object body and reports provider facts', async () => {
  const world = await startHttpWorld({ provider: { delayMs: 5000 } });
  try {
    const submitted = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'cancel me' } },
    });
    const handle = encodeURIComponent(submitted.body.handle);

    const bad = await world.request('POST', `/v1/tasks/${handle}/cancel`, { body: { force: true } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_ARGUMENT');

    const ok = await world.request('POST', `/v1/tasks/${handle}/cancel`, { body: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.state, 'cancelled');
    assert.equal(ok.body.handle, submitted.body.handle);
    assert.equal(ok.body.cancelRequested, undefined); // terminal: cancelRequest settled

    const after = await world.request('GET', `/v1/tasks/${handle}`);
    assert.equal(after.body.state, 'cancelled');
  } finally {
    await world.close();
  }
});

test('cancel acknowledgement lag: cancelRequested is a separate observation from terminal state', async () => {
  const world = await startHttpWorld({ provider: { delayMs: 5000, cancelAckMs: 40 } });
  try {
    const submitted = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'observe cancel' } },
    });
    const handle = encodeURIComponent(submitted.body.handle);

    // While the provider acknowledgement is pending, the snapshot exposes
    // cancelRequested without claiming a terminal cancelled state.
    const ack = await world.request('POST', `/v1/tasks/${handle}/cancel`, { body: {} });
    assert.equal(ack.status, 200);
    assert.ok(['accepted', 'running'].includes(ack.body.state), `unexpected state ${ack.body.state}`);
    assert.equal(ack.body.cancelRequested, true);

    // Provider facts remain the authority once the acknowledgement lands.
    await sleep(120);
    const after = await world.request('GET', `/v1/tasks/${handle}`);
    assert.equal(after.body.state, 'cancelled');
    assert.equal(after.body.cancelRequested, undefined);
  } finally {
    await world.close();
  }
});

test('unknown routes and wrong methods are rejected; no CORS headers are emitted', async () => {
  const world = await startHttpWorld();
  try {
    const cases = [
      ['GET', '/v1/nope'],
      ['GET', '/v1/connections'],
      ['POST', `/v1/tasks/${encodeURIComponent('h_x')}`],
      ['DELETE', `/v1/connections/${CONN}`],
      ['PUT', `/v1/connections/${CONN}/tasks`],
    ];
    for (const [method, path] of cases) {
      const res = await world.request(method, path);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const ok = await world.request('GET', `/v1/connections/${CONN}`);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    assert.equal(ok.headers.get('access-control-allow-methods'), null);
  } finally {
    await world.close();
  }
});

test('connector bugs never leak internals: plain errors become STATE_UNAVAILABLE', async () => {
  const world = await startHttpWorld();
  try {
    world.service.connector.get = async () => {
      throw new Error('secret internal detail: /home/someone/src/private.ts:42');
    };
    const submitted = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'x' } },
    });
    const res = await world.request('GET', `/v1/tasks/${encodeURIComponent(submitted.body.handle)}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'STATE_UNAVAILABLE');
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('secret internal'));
    assert.ok(!serialized.includes('private.ts'));
    assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message', 'retryable']);
  } finally {
    await world.close();
  }
});

test('query strings are ignored and percent-encoded handles round-trip', async () => {
  const world = await startHttpWorld();
  try {
    const described = await world.request('GET', `/v1/connections/${CONN}?verbose=1`);
    assert.equal(described.status, 200);

    const submitted = await world.request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { input: { type: 'text', text: 'x' } },
    });
    const rawHandle = submitted.body.handle;
    const encoded = encodeURIComponent(rawHandle);
    const got = await world.request('GET', `/v1/tasks/${encoded}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.handle, rawHandle);
  } finally {
    await world.close();
  }
});

test('abusive body gets a structured 400 with Connection: close, not a bare reset', async () => {
  const world = await startHttpWorld();
  try {
    // Beyond limit + drain slack: the server stops consuming, answers with
    // the structured error and closes the connection cleanly.
    const huge = { input: { type: 'text', text: 'x'.repeat(1024 * 1024 + 100000) } };
    const response = await fetch(`${world.base}/v1/connections/${CONN}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify(huge),
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('connection'), 'close');
    assert.equal((await response.json()).error.code, 'INVALID_ARGUMENT');
  } finally {
    await world.close();
  }
});

test('malformed HTTP request line gets a structured 400, not Node default HTML', async () => {
  const world = await startHttpWorld();
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: world.server.address().port }, () => {
        socket.write('NOT-A-VALID-REQUEST /\r\n\r\n');
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.includes('\r\n\r\n')) socket.end();
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('timed out waiting for clientError response'));
      });
    });
    assert.match(reply, /^HTTP\/1\.1 400 Bad Request/);
    assert.ok(reply.includes('INVALID_ARGUMENT'), reply);
    assert.ok(reply.includes('connection: close'), reply);
    assert.ok(!reply.includes('<html'), reply);
  } finally {
    await world.close();
  }
});
