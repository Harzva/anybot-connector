import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamBotProvider } from '../../src/providers/teambot/index.mjs';
import { createConnector } from '../../src/core/index.mjs';
import { createTeamBotFixture } from '../fixtures/teambot-http.mjs';
import { createHttpServer } from '../../src/transports/http/index.mjs';
import { createKnocketHandler } from '../../src/channels/knocket/index.mjs';
const identity = { principal: 'fixture-user' };
const invocation = { requestKey: 'one', input: { type: 'text', text: 'fixture input' } };
async function setup(options) {
  const fixture = await createTeamBotFixture(options), dir = await mkdtemp(join(tmpdir(), 'anybot-teambot-'));
  const provider = createTeamBotProvider({ ...fixture, operatorBinding: { publication: fixture.publication, botId: fixture.botId, acknowledgeUnverifiedOwnership: true } });
  const optionsForCore = { stateDir: dir, connections: [{ id: 'demo', revision: '1', publication: fixture.publication, grantId: 'trusted-fixture', provider }], authorize: async () => true };
  let connector = await createConnector(optionsForCore);
  return { fixture, provider, get connector() { return connector; }, dir,
    async restart() { await connector.close(); connector = await createConnector(optionsForCore); },
    async close() { await connector.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('TeamBot requires explicit operator trust; endpoint and redirects are constrained', async () => {
  assert.throws(() => createTeamBotProvider({}), { code: 'FORBIDDEN' });
  const w = await setup();
  try {
    w.fixture.fault.mode = 'redirect'; await assert.rejects(w.connector.describe(identity, 'demo'), { code: 'INVALID_UPSTREAM_RESPONSE' });
    w.fixture.fault.mode = 'wrong-publication'; await assert.rejects(w.connector.describe(identity, 'demo'), { code: 'FORBIDDEN' });
    w.fixture.fault.mode = null; const desc = await w.connector.describe(identity, 'demo'); assert.equal(desc.idempotency.durable, false);
  } finally { await w.close(); }
});
test('TeamBot maps submit/get/cancel, preserves terminal completion and rechecks withdrawal', async () => {
  const w = await setup({ delayMs: 1000 });
  try {
    const t = await w.connector.submit(identity, 'demo', invocation); assert.equal(t.state, 'running');
    assert.equal((await w.connector.cancel(identity, t.handle)).state, 'cancelled');
    assert.equal((await w.connector.get(identity, t.handle)).state, 'cancelled');
    w.fixture.fault.revoked = true; await assert.rejects(w.connector.get(identity, t.handle), { code: 'FORBIDDEN' });
  } finally { await w.close(); }
});
test('lost TeamBot receipt remains unknown across restart without repeated POST or fake lookup', async () => {
  const w = await setup();
  try {
    w.fixture.fault.mode = 'lost-submit';
    let recovery;
    await assert.rejects(w.connector.submit(identity, 'demo', invocation), e => { recovery = e.recovery; return e.code === 'UPSTREAM_OUTCOME_UNKNOWN'; });
    w.fixture.fault.mode = null;
    await w.restart();
    await assert.rejects(w.connector.submit(identity, 'demo', invocation), e => e.code === 'UPSTREAM_OUTCOME_UNKNOWN' && e.recovery.handle === recovery.handle);
    await assert.rejects(w.connector.get(identity, recovery.handle), { code: 'UPSTREAM_OUTCOME_UNKNOWN' });
    await assert.rejects(w.connector.cancel(identity, recovery.handle), { code: 'UPSTREAM_OUTCOME_UNKNOWN' });
    assert.equal(w.fixture.calls.submit, 1); assert.equal(w.fixture.calls.get, 0); assert.equal(w.fixture.calls.cancel, 0);
  } finally { await w.close(); }
});
test('saved opaque TeamBot receipt survives restart and rejects mismatched observations', async () => {
  const w = await setup();
  try {
    const t = await w.connector.submit(identity, 'demo', invocation); assert.equal(t.state, 'succeeded');
    const record = JSON.parse(await readFile(join(w.dir, 'state.json'), 'utf8')).tasks[t.handle];
    assert.match(record.providerTaskId, /^obt_/); assert.notEqual(record.providerTaskId, record.requestId);
    await w.restart();
    assert.equal((await w.connector.submit(identity, 'demo', invocation)).handle, t.handle);
    assert.equal(w.fixture.calls.submit, 1);
    assert.equal((await w.connector.cancel(identity, t.handle)).state, 'succeeded');
    for (const mode of ['oversize', 'unknown-state', 'wrong-id']) {
      w.fixture.fault.mode = mode; await assert.rejects(w.connector.get(identity, t.handle), { code: 'INVALID_UPSTREAM_RESPONSE' });
    }
  } finally { await w.close(); }
});
test('TeamBot input constraints fail before journaling and preserve a corrected retry key', async () => {
  const w = await setup();
  try {
    assert.deepEqual((await w.connector.describe(identity, 'demo')).limits,
      { textBytes: 20000, textCodeUnits: 6000, nonWhitespace: true, noNul: true });
    const before = await readFile(join(w.dir, 'state.json'), 'utf8');
    for (const text of ['x'.repeat(6001), '😀'.repeat(3001), ' \t\n', 'before\0after']) {
      await assert.rejects(w.connector.submit(identity, 'demo', { ...invocation, input: { type: 'text', text } }), e => e.code === 'INVALID_ARGUMENT' && e.recovery === undefined);
      assert.equal(await readFile(join(w.dir, 'state.json'), 'utf8'), before);
      assert.equal(w.fixture.calls.submit, 0);
    }
    for (const [i, text] of ['x'.repeat(5999), 'x'.repeat(6000), '中'.repeat(6000), '😀'.repeat(3000)].entries()) {
      const result = await w.connector.submit(identity, 'demo', { requestKey: i === 0 ? invocation.requestKey : `boundary-${i}`, input: { type: 'text', text } });
      assert.equal(result.state, 'succeeded'); assert.equal(result.result.text, `fixture:${text}`);
    }
    assert.equal(w.fixture.calls.submit, 4);
  } finally { await w.close(); }
});
test('TeamBot channel validates complete serialized history before dispatch', async () => {
  const w = await setup();
  const server = createHttpServer({ connector: w.connector, authenticate: async () => identity,
    knocket: createKnocketHandler({ connector: w.connector, models: { support: 'demo' } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chat = text => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'history-boundary' },
    body: JSON.stringify({ model: 'support', messages: [{ role: 'user', content: text }] }) });
  try {
    // The channel adds seven code units for '[user]\n'.
    const rejected = await chat('x'.repeat(5994)); assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'INVALID_ARGUMENT');
    assert.equal(w.fixture.calls.submit, 0);
    assert.deepEqual(JSON.parse(await readFile(join(w.dir, 'state.json'), 'utf8')).tasks, {});
    const accepted = await chat('x'.repeat(5993)); assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).choices[0].message.content, `fixture:[user]\n${'x'.repeat(5993)}`);
    assert.equal(w.fixture.calls.submit, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await w.close(); }
});
