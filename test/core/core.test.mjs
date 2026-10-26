import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnector } from '../../src/core/index.mjs';
import { createReferenceProvider } from '../../src/providers/reference/index.mjs';
import { ConnectorError } from '../../src/contract.mjs';
const alice = { principal: 'alice', endUserRef: 'one' };
const input = (key = 'request') => ({ requestKey: key, conversationRef: 'conversation', input: { type: 'text', text: 'synthetic private text' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function world({ delayMs = 200, authorize = async () => true, wrap = p => p, operationTimeoutMs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'anybot-core-'));
  const provider = await createReferenceProvider({ stateDir: join(dir, 'provider'), delayMs });
  const c = { id: 'demo', revision: '1', publication: 'demo', grantId: 'grant', provider: wrap(provider) };
  const core = await createConnector({ stateDir: join(dir, 'core'), connections: [c], authorize, operationTimeoutMs });
  return { dir, provider, c, core, async close() { await core.close(); await provider.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('provider recovery is explicit and limits cannot widen the generic ceiling', async () => {
  let descriptorMode = 'missing', effects = 0;
  const w = await world({ wrap: p => ({ ...p, async describe(ctx) {
    const d = await p.describe(ctx);
    if (descriptorMode === 'missing') delete d.recovery;
    else if (descriptorMode === 'malformed') d.recovery = { lookupByRequestId: 'yes' };
    else d.limits = { textBytes: 999999 };
    return d;
  }, async submit(...args) { effects++; return p.submit(...args); } }) });
  try {
    for (descriptorMode of ['missing', 'malformed']) {
      await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'INVALID_UPSTREAM_RESPONSE' });
      assert.equal(effects, 0);
      assert.deepEqual(JSON.parse(await readFile(join(w.dir, 'core', 'state.json'), 'utf8')).tasks, {});
    }
    descriptorMode = 'valid';
    assert.equal((await w.core.describe(alice, 'demo')).limits.textBytes, 20000);
    assert.equal((await w.core.submit(alice, 'demo', input())).state, 'running');
    assert.equal(effects, 1);
  } finally { await w.close(); }
});
test('concurrent retry, conflict, caller/end-user isolation and journal contains no body/result', async () => {
  let effects = 0;
  const w = await world({ wrap: p => ({ ...p, async submit(...args) { effects++; return p.submit(...args); } }) });
  try {
    const tasks = await Promise.all(Array.from({ length: 8 }, () => w.core.submit(alice, 'demo', input())));
    assert.equal(new Set(tasks.map(t => t.handle)).size, 1); assert.equal(effects, 1);
    await assert.rejects(w.core.submit(alice, 'demo', { ...input(), input: { type: 'text', text: 'changed' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    for (const identity of [{ principal: 'bob' }, { principal: 'alice', endUserRef: 'two' }]) {
      await assert.rejects(w.core.get(identity, tasks[0].handle), { code: 'NOT_FOUND' });
      const task = await w.core.submit(identity, 'demo', input()); assert.notEqual(task.handle, tasks[0].handle);
    }
    const journal = await readFile(join(w.dir, 'core', 'state.json'), 'utf8');
    assert.ok(!journal.includes('synthetic private text')); assert.ok(!journal.includes('[reference]'));
    await assert.rejects(w.core.submit(alice, 'demo', { ...input('bad'), role: 'admin' }), { code: 'INVALID_ARGUMENT' });
  } finally { await w.close(); }
});
test('unknown accepted submission recovers after restart with GET and never another POST', async () => {
  let effects = 0;
  const w = await world({ delayMs: 0, wrap: p => ({ ...p, async submit(...args) { effects++; await p.submit(...args); throw new Error('connection lost with private data'); } }) });
  try {
    let recovery;
    await assert.rejects(w.core.submit(alice, 'demo', input()), e => { assert.equal(e.code, 'UPSTREAM_OUTCOME_UNKNOWN'); recovery = e.recovery; return true; });
    await w.core.close(); await w.provider.close();
    const provider = await createReferenceProvider({ stateDir: join(w.dir, 'provider') });
    const restarted = await createConnector({ stateDir: join(w.dir, 'core'), connections: [{ ...w.c, provider }], authorize: async () => true });
    try {
      const task = await restarted.submit(alice, 'demo', input());
      assert.equal(task.handle, recovery.handle); assert.equal(task.state, 'succeeded'); assert.equal(effects, 1);
    } finally { await restarted.close(); await provider.close(); }
  } finally { await w.close(); }
});
test('unknown submit followed by 404 stays unknown and does not replay', async () => {
  let effects = 0;
  const w = await world({ wrap: p => ({ ...p, async submit() { effects++; throw new Error('unknown'); } }) });
  try {
    await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'UPSTREAM_OUTCOME_UNKNOWN' });
    await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'UPSTREAM_OUTCOME_UNKNOWN' });
    assert.equal(effects, 1);
  } finally { await w.close(); }
});
test('revoke during an upstream response prevents late disclosure, readonly cannot dispatch', async () => {
  let allowed = true, effects = 0;
  const w = await world({ authorize: async ({ identity, operation }) => allowed && (identity.principal !== 'readonly' || operation === 'get'),
    wrap: p => ({ ...p, async submit(...args) { effects++; const task = await p.submit(...args); allowed = false; return task; } }) });
  try {
    await assert.rejects(w.core.submit({ principal: 'readonly' }, 'demo', input()), { code: 'FORBIDDEN' }); assert.equal(effects, 0);
    await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'FORBIDDEN' }); assert.equal(effects, 1);
    await assert.rejects(w.core.describe(alice, 'demo'), { code: 'FORBIDDEN' });
  } finally { await w.close(); }
});
test('cancel respects completed provider facts; close denies new admission', async () => {
  const w = await world({ delayMs: 100 });
  try {
    const first = await w.core.submit(alice, 'demo', input('cancel'));
    assert.equal((await w.core.cancel(alice, first.handle)).state, 'cancelled');
    const second = await w.core.submit(alice, 'demo', input('complete')); await sleep(130);
    assert.equal((await w.core.cancel(alice, second.handle)).state, 'succeeded');
    assert.equal((await w.core.get(alice, second.handle)).state, 'succeeded');
    await w.core.close(); await assert.rejects(w.core.describe(alice, 'demo'), { code: 'SHUTTING_DOWN' });
  } finally { await w.close(); }
});
test('a second writer, route rebinding and damaged state fail closed', async () => {
  const w = await world();
  try {
    await assert.rejects(createConnector({ stateDir: join(w.dir, 'core'), connections: [w.c], authorize: async () => true }), { code: 'STATE_UNAVAILABLE' });
    await w.core.close();
    await assert.rejects(createConnector({ stateDir: join(w.dir, 'core'), connections: [{ ...w.c, grantId: 'another' }], authorize: async () => true }), { code: 'AUTHORITY_CHANGED' });
    await writeFile(join(w.dir, 'core', 'state.json'), '{truncated');
    await assert.rejects(createConnector({ stateDir: join(w.dir, 'core'), connections: [w.c], authorize: async () => true }), { code: 'STATE_UNAVAILABLE' });
  } finally { await w.close(); }
});
test('provider output validation and bounded operation timeout do not fabricate success', async () => {
  const w = await world({ operationTimeoutMs: 20, wrap: p => ({ ...p, async submit() { return new Promise(() => {}); } }) });
  try { await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'UPSTREAM_OUTCOME_UNKNOWN' }); }
  finally { await w.close(); }
  const bad = await world({ wrap: p => ({ ...p, async get() { return { taskId: 'wrong', state: 'magic', observedAt: 'today', result: { type: 'text', text: 'private' } }; } }) });
  try {
    const t = await bad.core.submit(alice, 'demo', input());
    await assert.rejects(bad.core.get(alice, t.handle), { code: 'INVALID_UPSTREAM_RESPONSE' });
  } finally { await bad.close(); }
});

test('a persistence failure before submission prevents every upstream effect', async () => {
  let effects = 0;
  const w = await world({ wrap: p => ({ ...p, async submit(...args) { effects++; return p.submit(...args); } }) });
  try {
    const { rename } = await import('node:fs/promises');
    await rename(join(w.dir, 'core', 'state.json'), join(w.dir, 'core', 'saved-state.json'));
    await mkdir(join(w.dir, 'core', 'state.json'));
    await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'STATE_UNAVAILABLE' });
    assert.equal(effects, 0);
    await assert.rejects(w.core.submit(alice, 'demo', input('other')), { code: 'STATE_UNAVAILABLE' });
    assert.equal(effects, 0);
  } finally { await w.close(); }
});

test('acknowledging cancellation does not change the provider state', async () => {
  const w = await world({ delayMs: 5000, wrap: p => ({ ...p, async cancel(ctx, id) { return { ...await p.get(ctx, id), cancelRequested: true }; } }) });
  try {
    const t = await w.core.submit(alice, 'demo', input());
    const result = await w.core.cancel(alice, t.handle);
    assert.equal(result.state, 'running'); assert.equal(result.cancelRequested, true);
  } finally { await w.close(); }
});

test('SIGKILL after provider acceptance recovers dead writer locks and original task, without replay', { timeout: 10000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'anybot-crash-'));
  const code = `
    import {createConnector} from './src/core/index.mjs';
    import {createReferenceProvider} from './src/providers/reference/index.mjs';
    const p = await createReferenceProvider({stateDir:process.env.CRASH_DIR+'/provider',delayMs:0});
    const c = await createConnector({stateDir:process.env.CRASH_DIR+'/core',connections:[{id:'demo',revision:'1',publication:'demo',grantId:'grant',provider:{...p,async submit(...a){await p.submit(...a);process.stdout.write('ACCEPTED\\n');await new Promise(()=>setInterval(()=>{},1000));}}}],authorize:async()=>true});
    await c.submit({principal:'alice',endUserRef:'one'},'demo',${JSON.stringify(input())});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: repo, env: { ...process.env, CRASH_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let provider, core;
  try {
    const accepted = await Promise.race([once(child.stdout, 'data').then(([b]) => b.toString()), once(child, 'exit').then(() => { throw new Error('child exited before acceptance'); })]);
    assert.match(accepted, /ACCEPTED/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    provider = await createReferenceProvider({ stateDir: join(dir, 'provider') });
    core = await createConnector({ stateDir: join(dir, 'core'), connections: [{ id: 'demo', revision: '1', publication: 'demo', grantId: 'grant', provider: { ...provider, async submit() { throw new Error('replay forbidden'); } } }], authorize: async () => true });
    const result = await core.submit(alice, 'demo', input());
    assert.equal(result.state, 'succeeded');
    assert.equal(Object.keys(JSON.parse(await readFile(join(dir, 'provider', 'state.json'))).tasks).length, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await core?.close(); await provider?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('describe narrows provider operations to current caller grants', async () => {
  const w = await world({ authorize: async ({ operation }) => ['describe', 'get'].includes(operation) });
  try {
    assert.deepEqual((await w.core.describe(alice, 'demo')).operations, ['describe', 'get']);
    await assert.rejects(w.core.submit(alice, 'demo', input()), { code: 'FORBIDDEN' });
  } finally { await w.close(); }
});
