import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ConnectorError } from '../contract.mjs';

const ref = /^[A-Za-z0-9_.:-]{1,128}$/;
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const ops = ['describe', 'submit', 'get', 'cancel'];
function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) throw new ConnectorError('INVALID_ARGUMENT');
}
function check(condition) { if (!condition) throw new ConnectorError('INVALID_ARGUMENT'); }
export async function loadConfig(file) {
  const text = await readFile(file, 'utf8');
  check(Buffer.byteLength(text) <= 65536);
  let c; try { c = JSON.parse(text); } catch { throw new ConnectorError('INVALID_ARGUMENT'); }
  exact(c, ['schemaVersion', 'stateDir', 'port', 'identities', 'connections', 'knocket']);
  check(c.schemaVersion === 1 && typeof c.stateDir === 'string' && c.stateDir.length > 0 && c.stateDir.length <= 4096);
  check(Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535);
  check(Array.isArray(c.connections) && c.connections.length > 0 && c.connections.length <= 32);
  const ids = new Set();
  for (const v of c.connections) {
    exact(v, ['id', 'revision', 'publication', 'grantId', 'provider']);
    check([v.id, v.revision, v.publication, v.grantId].every(s => typeof s === 'string' && ref.test(s)) && !ids.has(v.id)); ids.add(v.id);
    if (v.provider?.type === 'reference') {
      exact(v.provider, ['type', 'delayMs']);
      if (v.provider.delayMs !== undefined) check(Number.isInteger(v.provider.delayMs) && v.provider.delayMs >= 0 && v.provider.delayMs <= 60000);
    } else if (v.provider?.type === 'teambot') {
      exact(v.provider, ['type', 'baseUrl', 'tokenEnv', 'operatorBinding', 'timeoutMs']);
      check(typeof v.provider.baseUrl === 'string' && envName.test(v.provider.tokenEnv));
      exact(v.provider.operatorBinding, ['publication', 'botId', 'acknowledgeUnverifiedOwnership']);
      check(v.provider.operatorBinding.publication === v.publication && typeof v.provider.operatorBinding.botId === 'string' && ref.test(v.provider.operatorBinding.botId) && v.provider.operatorBinding.acknowledgeUnverifiedOwnership === true);
      if (v.provider.timeoutMs !== undefined) check(Number.isInteger(v.provider.timeoutMs) && v.provider.timeoutMs > 0 && v.provider.timeoutMs <= 60000);
    } else throw new ConnectorError('UNSUPPORTED_CAPABILITY');
  }
  check(Array.isArray(c.identities) && c.identities.length <= 64);
  const principals = new Set(), tokens = new Set();
  for (const v of c.identities) {
    exact(v, ['principal', 'tokenEnv', 'connections', 'operations']);
    check(typeof v.principal === 'string' && ref.test(v.principal) && !principals.has(v.principal)); principals.add(v.principal);
    check(typeof v.tokenEnv === 'string' && envName.test(v.tokenEnv) && !tokens.has(v.tokenEnv)); tokens.add(v.tokenEnv);
    check(Array.isArray(v.connections) && v.connections.every(id => ids.has(id)));
    check(Array.isArray(v.operations) && v.operations.every(op => ops.includes(op)));
  }
  if (c.knocket !== undefined) {
    exact(c.knocket, ['models']);
    check(c.knocket.models && typeof c.knocket.models === 'object' && !Array.isArray(c.knocket.models));
    check(Object.entries(c.knocket.models).every(([alias, id]) => ref.test(alias) && ids.has(id)));
  }
  c.stateDir = isAbsolute(c.stateDir) ? c.stateDir : resolve(dirname(resolve(file)), c.stateDir);
  return c;
}
export async function initConfig(file, stateDir) {
  check(typeof stateDir === 'string' && stateDir.length > 0);
  const c = { schemaVersion: 1, stateDir, port: 8790,
    identities: [{ principal: 'demo', tokenEnv: 'ANYBOT_TOKEN', connections: ['demo'], operations: ops }],
    connections: [{ id: 'demo', revision: '1', publication: 'demo', grantId: 'local', provider: { type: 'reference', delayMs: 20 } }],
    knocket: { models: { demo: 'demo' } } };
  await writeFile(file, JSON.stringify(c, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const hash = v => createHash('sha256').update(v).digest();
export function makeHostPolicy(configFile, initial, env = process.env) {
  const issued = new WeakMap();
  const route = c => JSON.stringify(c.connections);
  async function current() {
    let c; try { c = await loadConfig(configFile); } catch { throw new ConnectorError('FORBIDDEN'); }
    if (route(c) !== route(initial)) throw new ConnectorError('AUTHORITY_CHANGED');
    return c;
  }
  function issue(entry, credential) {
    const identity = Object.freeze({ principal: entry.principal });
    issued.set(identity, { tokenEnv: entry.tokenEnv, credential: hash(credential) });
    return identity;
  }
  return {
    async authenticate(req) {
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 4096) throw new ConnectorError('UNAUTHENTICATED');
      const token = authorization.slice(7), c = await current();
      for (const entry of c.identities) {
        const expected = env[entry.tokenEnv];
        if (typeof expected === 'string' && expected.length >= 24 && timingSafeEqual(hash(token), hash(expected))) return issue(entry, token);
      }
      throw new ConnectorError('UNAUTHENTICATED');
    },
    async stdioIdentity(principal) {
      const c = await current(), entry = c.identities.find(v => v.principal === principal);
      if (!entry || typeof env[entry.tokenEnv] !== 'string' || env[entry.tokenEnv].length < 24) throw new ConnectorError('UNAUTHENTICATED');
      return issue(entry, env[entry.tokenEnv]);
    },
    async authorize({ identity, operation, connection }) {
      const c = await current(), proof = issued.get(identity);
      const entry = c.identities.find(v => v.principal === identity.principal);
      if (!proof || !entry || proof.tokenEnv !== entry.tokenEnv || !env[entry.tokenEnv] || !timingSafeEqual(proof.credential, hash(env[entry.tokenEnv]))) return false;
      return entry.connections.includes(connection.id) && entry.operations.includes(operation);
    }
  };
}
