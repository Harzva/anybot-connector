// Cross-interface consistency: the SAME connector service behind the HTTP
// binding and the official MCP client must expose identical task facts and
// identical error documents for identical input.
//
// The matrix runs against Kimi's independent synthetic service AND against
// the delivered core + reference provider (src/core, src/providers/reference).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicError, ConnectorError, CONTRACT_VERSION, TERMINAL_STATES } from '../../src/contract.mjs';
import { createConnector } from '../../src/core/index.mjs';
import { createReferenceProvider } from '../../src/providers/reference/index.mjs';
import { createHttpServer } from '../../src/transports/http/index.mjs';
import { startHttpWorld, connectMcpClient, sleep, testAuthenticate } from '../transports/test-utils.mjs';

const CONN = 'conn-demo';
const ALICE = { principal: 'alice' };
const ALICE_V1 = { principal: 'alice', endUserRef: 'visitor-1' };
const ALICE_V2 = { principal: 'alice', endUserRef: 'visitor-2' };
const BOB = { principal: 'bob' };

// Two observations of the SAME task: identity must match; a later read may
// legitimately advance a non-terminal state (e.g. the provider finished
// between the two calls), but a terminal state is stable.
function assertSameTask(laterSnapshot, earlierSnapshot) {
  assert.equal(laterSnapshot.handle, earlierSnapshot.handle);
  assert.equal(laterSnapshot.requestKey, earlierSnapshot.requestKey);
  if (TERMINAL_STATES.includes(earlierSnapshot.state)) {
    assert.equal(laterSnapshot.state, earlierSnapshot.state);
    assert.deepEqual(laterSnapshot.result ?? null, earlierSnapshot.result ?? null);
  }
}

async function runConsistencyMatrix({ connector, request, providerEffectCount, terminalWaitMs }) {
  const mcpAlice = await connectMcpClient(connector, ALICE);
  const mcpBob = await connectMcpClient(connector, BOB);
  const mcpAliceV2 = await connectMcpClient(connector, ALICE_V2);
  try {
    // 1. Descriptor facts are identical across interfaces.
    const httpDesc = await request('GET', `/v1/connections/${CONN}`);
    assert.equal(httpDesc.status, 200);
    const mcpDesc = await mcpAlice.call('connector_describe', { connectionId: CONN });
    assert.equal(mcpDesc.isError, false);
    assert.deepEqual(mcpDesc.result, httpDesc.body);
    assert.equal(httpDesc.body.contractVersion, CONTRACT_VERSION);

    // 2. HTTP submit -> MCP get/cancel on the SAME task.
    const httpSubmit = await request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { requestKey: 'cross-t01', input: { type: 'text', text: 'submitted over http' } },
    });
    assert.equal(httpSubmit.status, 200);
    const mcpGet = await mcpAlice.call('connector_get', { handle: httpSubmit.body.handle });
    assert.equal(mcpGet.isError, false);
    assertSameTask(mcpGet.result, httpSubmit.body);

    await sleep(terminalWaitMs);
    const mcpCancel = await mcpAlice.call('connector_cancel', { handle: httpSubmit.body.handle });
    assert.equal(mcpCancel.isError, false);
    assert.equal(mcpCancel.result.state, 'succeeded'); // terminal facts win

    // 3. MCP submit -> HTTP get/cancel on the SAME task.
    const mcpSubmit = await mcpAlice.call('connector_submit', {
      connectionId: CONN,
      requestKey: 'cross-t02',
      input: { type: 'text', text: 'submitted over mcp' },
    });
    assert.equal(mcpSubmit.isError, false);
    const httpGet = await request('GET', `/v1/tasks/${encodeURIComponent(mcpSubmit.result.handle)}`);
    assert.equal(httpGet.status, 200);
    assertSameTask(httpGet.body, mcpSubmit.result);

    // Cancel races completion: the provider's final facts win (never a
    // fabricated cancellation), and both interfaces must observe the SAME
    // state. With a fast provider the task may already be terminal.
    const httpCancel = await request('POST', `/v1/tasks/${encodeURIComponent(mcpSubmit.result.handle)}/cancel`, { body: {} });
    assert.equal(httpCancel.status, 200);
    const mcpAfterCancel = await mcpAlice.call('connector_get', { handle: mcpSubmit.result.handle });
    assert.equal(mcpAfterCancel.isError, false);
    assert.equal(mcpAfterCancel.result.state, httpCancel.body.state);
    assert.ok(
      ['cancelled', 'succeeded'].includes(httpCancel.body.state),
      `unexpected provider fact: ${httpCancel.body.state}`,
    );

    // 4. Idempotency is canonical across transports: same key + same payload.
    const effectsBefore = providerEffectCount ? providerEffectCount() : 0;
    const payload = { requestKey: 'cross-idem', input: { type: 'text', text: 'identical text' } };
    const viaMcp = await mcpAlice.call('connector_submit', { connectionId: CONN, ...payload });
    assert.equal(viaMcp.isError, false);
    const viaHttp = await request('POST', `/v1/connections/${CONN}/tasks`, { body: payload });
    assert.equal(viaHttp.status, 200);
    assert.equal(viaHttp.body.handle, viaMcp.result.handle);
    if (providerEffectCount) assert.equal(providerEffectCount() - effectsBefore, 1);

    // 5. Idempotency conflict produces identical error documents both ways.
    const conflictHttp = await request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { requestKey: 'cross-idem', input: { type: 'text', text: 'different text' } },
    });
    assert.equal(conflictHttp.status, 409);
    const conflictMcp = await mcpAlice.call('connector_submit', {
      connectionId: CONN, requestKey: 'cross-idem', input: { type: 'text', text: 'different text' },
    });
    assert.equal(conflictMcp.isError, true);
    assert.deepEqual(conflictMcp.result, conflictHttp.body);
    assert.deepEqual(conflictHttp.body, { error: publicError(new ConnectorError('IDEMPOTENCY_CONFLICT')) });

    // 6. Guessed handles are NOT_FOUND with identical documents.
    const guessHttp = await request('GET', '/v1/tasks/h_guessed-cross');
    assert.equal(guessHttp.status, 404);
    const guessMcp = await mcpAlice.call('connector_get', { handle: 'h_guessed-cross' });
    assert.equal(guessMcp.isError, true);
    assert.deepEqual(guessMcp.result, guessHttp.body);

    // 7. Ownership isolation is consistent across interfaces.
    const aliceTask = await request('POST', `/v1/connections/${CONN}/tasks`, {
      body: { requestKey: 'cross-iso', input: { type: 'text', text: 'alice private' } },
      headers: { 'x-test-user': 'alice', 'x-test-visitor': 'visitor-1' },
    });
    assert.equal(aliceTask.status, 200);
    const handle = aliceTask.body.handle;
    const bobHttp = await request('GET', `/v1/tasks/${encodeURIComponent(handle)}`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(bobHttp.status, 404);
    const bobMcp = await mcpBob.call('connector_get', { handle });
    assert.equal(bobMcp.isError, true);
    assert.deepEqual(bobMcp.result, bobHttp.body);
    // Same principal, different endUserRef is also isolated, on both interfaces.
    const v2Http = await request('GET', `/v1/tasks/${encodeURIComponent(handle)}`, {
      headers: { 'x-test-user': 'alice', 'x-test-visitor': 'visitor-2' },
    });
    assert.equal(v2Http.status, 404);
    const v2Mcp = await mcpAliceV2.call('connector_get', { handle });
    assert.equal(v2Mcp.isError, true);
    assert.deepEqual(v2Mcp.result, v2Http.body);

    // 8. Invalid input produces identical facts on both interfaces. These
    // are DOMAIN violations (charset / byte length); structural violations
    // are rejected one layer earlier by the SDK on MCP with SDK messages.
    const invalidCases = [
      [{ connectionId: 'bad id!', input: { type: 'text', text: 'ok' } }, { connectionId: 'bad id!', input: { type: 'text', text: 'ok' } }],
      [{ connectionId: CONN, input: { type: 'text', text: 'é'.repeat(10001) } }, { connectionId: CONN, input: { type: 'text', text: 'é'.repeat(10001) } }],
      [{ connectionId: CONN, requestKey: 'a b', input: { type: 'text', text: 'ok' } }, { connectionId: CONN, requestKey: 'a b', input: { type: 'text', text: 'ok' } }],
    ];
    for (const [httpBody, mcpArgs] of invalidCases) {
      const httpRes = await request('POST', `/v1/connections/${CONN}/tasks`, { body: httpBody });
      assert.equal(httpRes.status, 400);
      const mcpRes = await mcpAlice.call('connector_submit', mcpArgs);
      assert.equal(mcpRes.isError, true);
      assert.deepEqual(mcpRes.result, httpRes.body, JSON.stringify(httpBody));
      assert.deepEqual(httpRes.body, { error: publicError(new ConnectorError('INVALID_ARGUMENT')) });
    }
  } finally {
    await mcpAlice.close();
    await mcpBob.close();
    await mcpAliceV2.close();
  }
}

test('HTTP and MCP expose identical facts over the independent synthetic service', async () => {
  const world = await startHttpWorld({ provider: { delayMs: 120 } });
  try {
    await runConsistencyMatrix({
      connector: world.service.connector,
      request: world.request,
      providerEffectCount: () => world.provider.submitCount(),
      terminalWaitMs: 400,
    });
  } finally {
    await world.close();
  }
});

test('HTTP and MCP expose identical facts over the real core and reference provider', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anybot-cross-core-'));
  const providerStateDir = await mkdtemp(join(tmpdir(), 'anybot-cross-provider-'));
  try {
    const provider = await createReferenceProvider({
      stateDir: providerStateDir,
      delayMs: 40,
    });
    const connector = await createConnector({
      stateDir,
      connections: [{
        id: CONN,
        revision: 'rev-1',
        publication: 'support-demo',
        grantId: 'grant-demo',
        provider,
      }],
      authorize: async ({ operation, identity }) => identity.principal !== 'mallory' || operation === 'describe',
    });
    const server = createHttpServer({ connector, authenticate: testAuthenticate });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const request = async (method, path, { body, headers } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': 'alice', ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json;
      try { json = await response.json(); } catch { json = undefined; }
      return { status: response.status, body: json, headers: response.headers };
    };

    try {
      await runConsistencyMatrix({
        connector,
        request,
        providerEffectCount: undefined,
        terminalWaitMs: 300,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await connector.close();
      await provider.close?.();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(providerStateDir, { recursive: true, force: true });
  }
});
