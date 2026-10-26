import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfig, loadConfig, makeHostPolicy } from '../../src/cli/config.mjs';

test('host authenticates bearer, rejects forged identity and applies live revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybot-policy-'));
  try {
    const file = join(dir, 'config.json'); await initConfig(file, './state');
    const initial = await loadConfig(file), env = { ANYBOT_TOKEN: 'synthetic-secret-for-config-test' };
    const policy = makeHostPolicy(file, initial, env), connection = initial.connections[0];
    await assert.rejects(policy.authenticate({ headers: { authorization: 'Bearer wrong' } }), { code: 'UNAUTHENTICATED' });
    const identity = await policy.authenticate({ headers: { authorization: `Bearer ${env.ANYBOT_TOKEN}` } });
    assert.equal(await policy.authorize({ identity, operation: 'submit', connection }), true);
    assert.equal(await policy.authorize({ identity: { principal: 'demo' }, operation: 'submit', connection }), false);
    const c = JSON.parse(await readFile(file)); c.identities[0].operations = ['describe'];
    await writeFile(file, JSON.stringify(c));
    assert.equal(await policy.authorize({ identity, operation: 'submit', connection }), false);
    c.connections[0].revision = '2'; await writeFile(file, JSON.stringify(c));
    await assert.rejects(policy.authorize({ identity, operation: 'describe', connection }), { code: 'AUTHORITY_CHANGED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('init never overwrites config and malformed policies fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybot-policy-'));
  try {
    const file = join(dir, 'config.json'); await initConfig(file, './state');
    await assert.rejects(initConfig(file, './state'), { code: 'EEXIST' });
    const c = JSON.parse(await readFile(file)); c.identities[0].role = 'admin';
    await writeFile(file, JSON.stringify(c)); await assert.rejects(loadConfig(file), { code: 'INVALID_ARGUMENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
