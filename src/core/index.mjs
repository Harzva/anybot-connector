import { createHash, randomUUID } from 'node:crypto';
import { openStore } from './storage.mjs';
import { ConnectorError, CONTRACT_VERSION, LIMITS, STATES } from '../contract.mjs';

const ref = /^[A-Za-z0-9_.:-]{1,128}$/, digest = /^[a-f0-9]{64}$/;
const taskRef = /^[A-Za-z0-9_.:-]{1,256}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new ConnectorError(code); };
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(value, keys, code = 'INVALID_ARGUMENT') {
  if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) fail(code);
}
function identityKey(identity) {
  if (!object(identity) || typeof identity.principal !== 'string' || !identity.principal.length || identity.principal.length > 128 ||
      (identity.endUserRef !== undefined && (typeof identity.endUserRef !== 'string' || !identity.endUserRef.length || identity.endUserRef.length > 128))) fail('UNAUTHENTICATED');
  return hash([identity.principal, identity.endUserRef ?? null]);
}
function invocation(input) {
  exact(input, ['requestKey', 'conversationRef', 'input']); exact(input.input, ['type', 'text']);
  if (input.input.type !== 'text') fail('UNSUPPORTED_CAPABILITY');
  if (typeof input.input.text !== 'string' || !input.input.text.length || Buffer.byteLength(input.input.text) > LIMITS.textBytes) fail('INVALID_ARGUMENT');
  const key = input.requestKey === undefined ? randomUUID() : input.requestKey;
  const conversation = input.conversationRef === undefined ? key : input.conversationRef;
  if (typeof key !== 'string' || !ref.test(key) || typeof conversation !== 'string' || !ref.test(conversation)) fail('INVALID_ARGUMENT');
  return { requestKey: key, conversationRef: conversation, input: { type: 'text', text: input.input.text } };
}
function validateJournal(db) {
  if (!object(db) || db.schema !== 1 || !object(db.routes) || !object(db.tasks) || !object(db.keys)) fail('STATE_UNAVAILABLE');
  for (const value of Object.values(db.routes)) if (!digest.test(value)) fail('STATE_UNAVAILABLE');
  const records = Object.entries(db.tasks);
  if (records.length > 10000 || Object.keys(db.keys).length !== records.length) fail('STATE_UNAVAILABLE');
  for (const [handle, r] of records) {
    if (!object(r) || !/^h_[0-9a-f-]{36}$/.test(handle) || r.handle !== handle || !ref.test(r.connectionId) ||
      ![r.owner, r.namespace, r.payloadDigest, r.requestId, r.conversationId].every(x => typeof x === 'string' && digest.test(x)) ||
      !ref.test(r.requestKey) || !ref.test(r.conversationRef) || !['SUBMITTING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(r.phase) ||
      (r.lookupByRequestId !== undefined && typeof r.lookupByRequestId !== 'boolean') ||
      (r.providerTaskId !== undefined && (typeof r.providerTaskId !== 'string' || !taskRef.test(r.providerTaskId))) ||
      (r.lookupByRequestId === false && r.phase === 'ACKNOWLEDGED' && r.providerTaskId === undefined) ||
      db.keys[r.requestId] !== handle || r.requestId !== hash([r.namespace, r.requestKey]) || r.conversationId !== hash([r.namespace, r.conversationRef]) ||
      !Object.hasOwn(db.routes, r.connectionId)) fail('STATE_UNAVAILABLE');
  }
}
function descriptor(value, connection) {
  if (!object(value) || value.contractVersion !== CONTRACT_VERSION || typeof value.provider !== 'string' || !ref.test(value.provider) ||
      !Array.isArray(value.operations) || !['describe', 'submit', 'get'].every(x => value.operations.includes(x)) ||
      value.operations.some(x => !['describe', 'submit', 'get', 'cancel'].includes(x)) ||
      value.input?.text !== true || value.input.attachments !== false || value.output?.text !== true || value.output.tokenStreaming !== false ||
      typeof value.idempotency?.durable !== 'boolean' || (value.idempotency.retentionSeconds !== null && (!Number.isSafeInteger(value.idempotency.retentionSeconds) || value.idempotency.retentionSeconds < 0)) ||
      !['request-and-observe', 'unsupported'].includes(value.cancellation) || value.humanHandoff !== false) fail('INVALID_UPSTREAM_RESPONSE');
  const limits = value.limits ?? {};
  exact(limits, ['textBytes', 'textCodeUnits', 'nonWhitespace', 'noNul'], 'INVALID_UPSTREAM_RESPONSE');
  for (const key of ['textBytes', 'textCodeUnits']) {
    if (limits[key] !== undefined && (!Number.isSafeInteger(limits[key]) || limits[key] < 1)) fail('INVALID_UPSTREAM_RESPONSE');
  }
  for (const key of ['nonWhitespace', 'noNul']) {
    if (limits[key] !== undefined && typeof limits[key] !== 'boolean') fail('INVALID_UPSTREAM_RESPONSE');
  }
  const recovery = value.recovery;
  exact(recovery, ['lookupByRequestId'], 'INVALID_UPSTREAM_RESPONSE');
  if (typeof recovery.lookupByRequestId !== 'boolean') fail('INVALID_UPSTREAM_RESPONSE');
  return { contractVersion: CONTRACT_VERSION, provider: value.provider, publication: connection.publication,
    operations: [...new Set(value.operations)], input: { text: true, attachments: false }, output: { text: true, tokenStreaming: false },
    idempotency: { durable: value.idempotency.durable, retentionSeconds: value.idempotency.retentionSeconds },
    cancellation: value.cancellation, humanHandoff: false, recovery: { lookupByRequestId: recovery.lookupByRequestId },
    limits: { ...limits, textBytes: Math.min(limits.textBytes ?? LIMITS.textBytes, LIMITS.textBytes) } };
}
function providerInput(text, limits) {
  if (Buffer.byteLength(text) > limits.textBytes || (limits.textCodeUnits !== undefined && text.length > limits.textCodeUnits) ||
      (limits.nonWhitespace && !text.trim().length) || (limits.noNul && text.includes('\0'))) fail('INVALID_ARGUMENT');
}
function snapshot(value, record, submitting = false) {
  const expected = submitting && record.lookupByRequestId === false ? undefined : (record.providerTaskId ?? record.requestId);
  if (!object(value) || typeof value.taskId !== 'string' || !taskRef.test(value.taskId) || (expected !== undefined && value.taskId !== expected) || !STATES.includes(value.state) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
      (value.cancelRequested !== undefined && typeof value.cancelRequested !== 'boolean')) fail('INVALID_UPSTREAM_RESPONSE');
  if (value.state === 'succeeded') {
    if (value.result?.type !== 'text' || typeof value.result.text !== 'string' || Buffer.byteLength(value.result.text) > LIMITS.responseBytes) fail('INVALID_UPSTREAM_RESPONSE');
  } else if (value.result !== undefined) fail('INVALID_UPSTREAM_RESPONSE');
  return { handle: record.handle, requestKey: record.requestKey, state: value.state, observedAt: value.observedAt,
    ...(value.result === undefined ? {} : { result: { type: 'text', text: value.result.text } }),
    ...(value.cancelRequested === undefined ? {} : { cancelRequested: value.cancelRequested }) };
}
export async function createConnector({ stateDir, connections, authorize, operationTimeoutMs = 10000 } = {}) {
  if (typeof stateDir !== 'string' || !Array.isArray(connections) || !connections.length || typeof authorize !== 'function' || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 60000) fail('INVALID_ARGUMENT');
  const routes = new Map();
  for (const source of connections) {
    if (![source.id, source.revision, source.publication, source.grantId].every(x => typeof x === 'string' && ref.test(x)) || routes.has(source.id) || !['describe', 'submit', 'get'].every(x => typeof source.provider?.[x] === 'function')) fail('INVALID_ARGUMENT');
    const connection = Object.freeze({ ...source });
    routes.set(connection.id, connection);
  }
  const store = await openStore(stateDir, { schema: 1, routes: {}, tasks: {}, keys: {} }, validateJournal);
  try {
    await store.transaction(db => {
      for (const c of routes.values()) {
        const fingerprint = hash([c.revision, c.publication, c.grantId, c.provider.bindingId ?? null]);
        if (Object.hasOwn(db.routes, c.id) && db.routes[c.id] !== fingerprint) fail('AUTHORITY_CHANGED');
        Object.defineProperty(db.routes, c.id, { value: fingerprint, enumerable: true, writable: true, configurable: true });
      }
    });
  } catch (e) { await store.close(); throw e; }
  let admitting = true;
  const active = new Set(), keyed = new Map();
  function run(fn) {
    if (!admitting) return Promise.reject(new ConnectorError('SHUTTING_DOWN'));
    const promise = Promise.resolve().then(fn); active.add(promise);
    promise.then(() => active.delete(promise), () => active.delete(promise)); return promise;
  }
  async function authorized(identity, connection, operation) {
    identityKey(identity);
    let allowed;
    try { allowed = await authorize({ identity, connection, operation }); }
    catch (e) { if (e instanceof ConnectorError && e.code === 'AUTHORITY_CHANGED') throw e; fail('FORBIDDEN'); }
    if (allowed !== true) fail('FORBIDDEN');
  }
  function context(identity, connection, record) {
    return { namespace: record?.namespace ?? hash([connection.id, connection.revision, connection.publication, connection.grantId, identity.principal, identity.endUserRef ?? null]),
      publication: connection.publication, ...(record ? { requestId: record.requestId, conversationId: record.conversationId } : {}) };
  }
  async function call(connection, operation, ctx, arg) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => connection.provider[operation]({ ...ctx, signal: controller.signal }, arg)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ConnectorError(operation === 'submit' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE')); }, operationTimeoutMs); })]);
    } catch (e) { if (e instanceof ConnectorError) throw e; throw new ConnectorError(operation === 'submit' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  }
  function route(id) { const c = routes.get(id); if (!c) fail('NOT_FOUND'); return c; }
  async function caps(identity, c) { const value = descriptor(await call(c, 'describe', context(identity, c)), c); if (value.operations.includes('cancel') && typeof c.provider.cancel !== 'function') fail('INVALID_UPSTREAM_RESPONSE'); return value; }
  function locate(identity, handle) {
    const owner = identityKey(identity);
    if (typeof handle !== 'string' || !handle.length || handle.length > 256) fail('INVALID_ARGUMENT');
    const tasks = store.read().tasks, record = Object.hasOwn(tasks, handle) ? tasks[handle] : undefined;
    if (!record || record.owner !== owner) fail('NOT_FOUND');
    return { record, c: route(record.connectionId) };
  }
  const recoverError = record => new ConnectorError('UPSTREAM_OUTCOME_UNKNOWN', { recovery: { handle: record.handle, requestKey: record.requestKey } });
  async function readTask(identity, c, record, operation = 'get') {
    await authorized(identity, c, operation);
    if (record.lookupByRequestId === false && record.providerTaskId === undefined) throw recoverError(record);
    if (operation === 'cancel' && (!(await caps(identity, c)).operations.includes('cancel') || typeof c.provider.cancel !== 'function')) fail('UNSUPPORTED_CAPABILITY');
    let value;
    try { value = snapshot(await call(c, operation, context(identity, c, record), record.providerTaskId ?? record.requestId), record); }
    catch (e) { await authorized(identity, c, operation); if (e.code === 'NOT_FOUND') throw recoverError(record); throw e; }
    await authorized(identity, c, operation); return value;
  }
  return {
    describe: (identity, id) => run(async () => {
      const c = route(id); await authorized(identity, c, 'describe'); const value = await caps(identity, c);
      const granted = [];
      for (const operation of value.operations) {
        try { await authorized(identity, c, operation); granted.push(operation); }
        catch (e) { if (e.code !== 'FORBIDDEN') throw e; }
      }
      await authorized(identity, c, 'describe'); return { ...value, operations: granted };
    }),
    submit: (identity, id, input) => run(async () => {
      const owner = identityKey(identity), inv = invocation(input), c = route(id);
      const ctx = context(identity, c), requestId = hash([ctx.namespace, inv.requestKey]);
      const previous = keyed.get(requestId) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        await authorized(identity, c, 'submit');
        const payloadDigest = hash([inv.conversationRef, 'text', inv.input.text]);
        const db = store.read(), handle = db.keys[requestId];
        if (handle) {
          const existing = db.tasks[handle];
          if (existing.payloadDigest !== payloadDigest) fail('IDEMPOTENCY_CONFLICT');
          const value = await readTask(identity, c, existing); await authorized(identity, c, 'submit'); return value;
        }
        const capabilities = await caps(identity, c);
        providerInput(inv.input.text, capabilities.limits);
        await authorized(identity, c, 'submit');
        const record = { handle: `h_${randomUUID()}`, owner, connectionId: c.id, namespace: ctx.namespace, requestId,
          requestKey: inv.requestKey, conversationRef: inv.conversationRef, conversationId: hash([ctx.namespace, inv.conversationRef]), payloadDigest,
          lookupByRequestId: capabilities.recovery.lookupByRequestId, phase: 'SUBMITTING' };
        await store.transaction(d => { if (Object.keys(d.tasks).length >= 10000) fail('RATE_LIMITED'); d.tasks[record.handle] = record; d.keys[requestId] = record.handle; });
        await authorized(identity, c, 'submit');
        let value, receipt;
        try { receipt = await call(c, 'submit', context(identity, c, record), inv); value = snapshot(receipt, record, true); }
        catch (e) {
          await store.transaction(d => { d.tasks[record.handle].phase = 'UNKNOWN'; });
          await authorized(identity, c, 'submit');
          if (['FORBIDDEN', 'UNAUTHENTICATED', 'AUTHORITY_CHANGED'].includes(e.code)) throw e;
          throw recoverError(record);
        }
        try { await store.transaction(d => { d.tasks[record.handle].phase = 'ACKNOWLEDGED'; d.tasks[record.handle].providerTaskId = receipt.taskId; }); }
        catch { await authorized(identity, c, 'submit'); throw new ConnectorError('STATE_UNAVAILABLE', { recovery: { handle: record.handle, requestKey: record.requestKey } }); }
        await authorized(identity, c, 'submit'); return value;
      });
      keyed.set(requestId, work);
      try { return await work; } finally { if (keyed.get(requestId) === work) keyed.delete(requestId); }
    }),
    get: (identity, handle) => run(async () => { const { record, c } = locate(identity, handle); return readTask(identity, c, record); }),
    cancel: (identity, handle) => run(async () => { const { record, c } = locate(identity, handle); return readTask(identity, c, record, 'cancel'); }),
    async close() { admitting = false; await Promise.allSettled([...active]); await store.close(); }
  };
}
