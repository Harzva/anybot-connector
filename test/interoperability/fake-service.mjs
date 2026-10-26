// Independent synthetic connector service for Kimi's black-box tests.
//
// This is NOT the project core and NOT a fixture of the coordinator: it is a
// from-spec reimplementation of the connector service surface
// ({ describe, submit, get, cancel, close }) plus a deterministic in-memory
// provider, used to exercise the HTTP/MCP bindings and the Knocket channel
// without waiting for src/core. When the real core lands, the same test
// scenarios run against it in cross-interface.test.mjs.
//
// Test scope: in-memory only, synthetic data, no network upstream, no model.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ConnectorError, LIMITS, TERMINAL_STATES } from '../../src/contract.mjs';

const REF_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESULT_PREFIX = '[synthetic-provider] ';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isoNow() {
  return new Date().toISOString();
}

function validateIdentity(identity) {
  if (typeof identity?.principal !== 'string' || identity.principal.length === 0 || identity.principal.length > LIMITS.referenceLength) {
    throw new ConnectorError('UNAUTHENTICATED');
  }
  if (identity.endUserRef !== undefined && (typeof identity.endUserRef !== 'string' || identity.endUserRef.length === 0)) {
    throw new ConnectorError('UNAUTHENTICATED');
  }
  return identity;
}

function sameIdentity(a, b) {
  return a.principal === b.principal && (a.endUserRef ?? null) === (b.endUserRef ?? null);
}

function validateInvocation(invocation) {
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  for (const key of Object.keys(invocation)) {
    if (key !== 'requestKey' && key !== 'conversationRef' && key !== 'input') {
      throw new ConnectorError('INVALID_ARGUMENT');
    }
  }
  const { requestKey, conversationRef, input } = invocation;
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !REF_PATTERN.test(requestKey))) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  if (conversationRef !== undefined && (typeof conversationRef !== 'string' || !REF_PATTERN.test(conversationRef))) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'type' && key !== 'text') throw new ConnectorError('INVALID_ARGUMENT');
  }
  if (input.type !== 'text') throw new ConnectorError('INVALID_ARGUMENT');
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  if (Buffer.byteLength(input.text, 'utf8') > LIMITS.textBytes) {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
}

function makeDescriptor(connection) {
  return {
    contractVersion: CONTRACT_VERSION,
    provider: 'synthetic-fake',
    publication: connection.publication,
    operations: ['describe', 'submit', 'get', 'cancel'],
    input: { text: true, attachments: false },
    output: { text: true, tokenStreaming: false },
    idempotency: { durable: true, retentionSeconds: 86400 },
    cancellation: 'request-and-observe',
    humanHandoff: false,
  };
}

// Deterministic in-memory provider with controllable timing and failure modes.
// mode: 'normal' | 'never' (stays running) | 'failed' (terminal failed) |
//       'submit-error' (submit throws UPSTREAM_UNAVAILABLE)
// cancelAckMs > 0 emulates a provider whose cancellation acknowledgement
// lags: cancel() leaves the task running for that window.
function createSyntheticProvider({ delayMs = 15, mode = 'normal', cancelAckMs = 0 } = {}) {
  const tasks = new Map();
  const timers = new Set();
  let submits = 0;

  const schedule = (fn, at) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.max(0, at - Date.now()));
    timers.add(timer);
  };

  return {
    async submit({ requestId, conversationId }, { text }) {
      submits += 1;
      if (mode === 'submit-error') throw new ConnectorError('UPSTREAM_UNAVAILABLE');
      const task = {
        taskId: requestId,
        conversationId,
        state: 'accepted',
        text,
        result: undefined,
        acceptedAt: Date.now(),
      };
      tasks.set(requestId, task);
      if (mode !== 'never') {
        schedule(() => { if (task.state === 'accepted') task.state = 'running'; }, task.acceptedAt + Math.max(1, Math.floor(delayMs / 2)));
        schedule(() => {
          if (task.state !== 'running') return;
          if (mode === 'failed') {
            task.state = 'failed';
          } else {
            task.state = 'succeeded';
            task.result = `${RESULT_PREFIX}${text}`;
          }
        }, task.acceptedAt + delayMs);
      }
      return { taskId: requestId, state: task.state };
    },
    async get(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new ConnectorError('NOT_FOUND');
      return { taskId, state: task.state, text: task.result };
    },
    async cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new ConnectorError('NOT_FOUND');
      if (!TERMINAL_STATES.includes(task.state)) {
        if (cancelAckMs > 0) {
          schedule(() => {
            if (!TERMINAL_STATES.includes(task.state)) task.state = 'cancelled';
          }, Date.now() + cancelAckMs);
        } else {
          task.state = 'cancelled';
        }
      }
      return { taskId, state: task.state, text: task.result };
    },
    submitCount() { return submits; },
    close() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}

// From-spec connector semantics: fixed routes, hashed request namespace,
// idempotent same-key handling, principal+endUserRef ownership.
export function createFakeService({
  connections = [{ id: 'conn-demo', revision: 'rev-1', publication: 'support-demo', grantId: 'grant-demo' }],
  authorize = async () => true,
  provider = {},
} = {}) {
  const providerApi = createSyntheticProvider(provider);
  const routes = new Map(connections.map((connection) => [connection.id, { ...connection }]));
  const tasksByHandle = new Map();
  const recordsByKey = new Map();
  const inflight = new Map();
  const calls = { describe: 0, submit: 0, get: 0, cancel: 0 };
  let lastSubmit = undefined;

  async function checkAuthorized(operation, identity, connection) {
    let allowed;
    try {
      allowed = await authorize({ operation, identity, connection });
    } catch (error) {
      throw error instanceof ConnectorError ? error : new ConnectorError('FORBIDDEN');
    }
    if (allowed !== true) throw new ConnectorError('FORBIDDEN');
  }

  function findConnection(connectionId) {
    const connection = routes.get(connectionId);
    if (!connection) throw new ConnectorError('NOT_FOUND');
    return connection;
  }

  function snapshotOf(record, providerFacts) {
    const snapshot = {
      handle: record.handle,
      requestKey: record.requestKey,
      state: providerFacts.state,
      observedAt: isoNow(),
    };
    if (providerFacts.state === 'succeeded') {
      if (typeof providerFacts.text !== 'string') throw new ConnectorError('INVALID_UPSTREAM_RESPONSE');
      snapshot.result = { type: 'text', text: providerFacts.text };
    }
    if (record.cancelRequested && !TERMINAL_STATES.includes(providerFacts.state)) {
      snapshot.cancelRequested = true;
    }
    return snapshot;
  }

  function recordFor(identity, handle) {
    const record = tasksByHandle.get(handle);
    if (!record || !sameIdentity(record.identity, identity)) {
      throw new ConnectorError('NOT_FOUND');
    }
    return record;
  }

  async function doSubmit(identity, connection, invocation) {
    validateInvocation(invocation);
    const requestKey = invocation.requestKey ?? randomUUID();
    const conversationRef = invocation.conversationRef ?? requestKey;
    const canonical = JSON.stringify([conversationRef, 'text', invocation.input.text]);
    const namespace = sha256(JSON.stringify([
      connection.id, connection.revision, connection.publication, connection.grantId,
      identity.principal, identity.endUserRef ?? null,
    ]));
    const dedupKey = `${namespace}|${requestKey}`;
    const existing = recordsByKey.get(dedupKey);
    if (existing) {
      if (existing.canonical !== canonical) throw new ConnectorError('IDEMPOTENCY_CONFLICT');
      const facts = await providerApi.get(existing.requestId);
      return snapshotOf(existing, facts);
    }
    const requestId = sha256(JSON.stringify([namespace, requestKey]));
    const conversationId = sha256(JSON.stringify([namespace, conversationRef]));
    await providerApi.submit({ namespace, requestId, conversationId }, { text: invocation.input.text });
    const record = {
      handle: `h_${randomBytes(12).toString('base64url')}`,
      requestKey,
      conversationRef,
      canonical,
      namespace,
      requestId,
      identity: { principal: identity.principal, endUserRef: identity.endUserRef },
      connectionId: connection.id,
      cancelRequested: false,
    };
    tasksByHandle.set(record.handle, record);
    recordsByKey.set(dedupKey, record);
    const facts = await providerApi.get(record.requestId);
    return snapshotOf(record, facts);
  }

  const connector = {
    async describe(identity, connectionId) {
      calls.describe += 1;
      validateIdentity(identity);
      const connection = findConnection(connectionId);
      await checkAuthorized('describe', identity, connection);
      return makeDescriptor(connection);
    },
    async submit(identity, connectionId, invocation) {
      calls.submit += 1;
      validateIdentity(identity);
      const connection = findConnection(connectionId);
      await checkAuthorized('submit', identity, connection);
      lastSubmit = { connectionId, invocation: JSON.parse(JSON.stringify(invocation)), principal: identity.principal };
      // Serialize same-namespace same-key submissions: one upstream effect.
      const provisionalKey = JSON.stringify([connectionId, identity.principal, identity.endUserRef ?? null, invocation?.requestKey ?? null]);
      const previous = inflight.get(provisionalKey) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => doSubmit(identity, connection, invocation));
      inflight.set(provisionalKey, run);
      try {
        return await run;
      } finally {
        if (inflight.get(provisionalKey) === run) inflight.delete(provisionalKey);
      }
    },
    async get(identity, handle) {
      calls.get += 1;
      validateIdentity(identity);
      const record = recordFor(identity, handle);
      await checkAuthorized('get', identity, routes.get(record.connectionId));
      const facts = await providerApi.get(record.requestId);
      return snapshotOf(record, facts);
    },
    async cancel(identity, handle) {
      calls.cancel += 1;
      validateIdentity(identity);
      const record = recordFor(identity, handle);
      await checkAuthorized('cancel', identity, routes.get(record.connectionId));
      record.cancelRequested = true;
      const facts = await providerApi.cancel(record.requestId);
      return snapshotOf(record, facts);
    },
    async close() {
      providerApi.close();
    },
  };

  return {
    connector,
    provider: providerApi,
    calls,
    lastSubmit: () => lastSubmit,
  };
}
