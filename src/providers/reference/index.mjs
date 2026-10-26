import { openStore } from '../../core/storage.mjs';
import { ConnectorError, CONTRACT_VERSION, LIMITS } from '../../contract.mjs';
const fail = code => { throw new ConnectorError(code); };
export async function createReferenceProvider({ stateDir, delayMs = 20 } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) fail('INVALID_ARGUMENT');
  const store = await openStore(stateDir, { schema: 1, tasks: {} }, db => {
    if (db?.schema !== 1 || !db.tasks || typeof db.tasks !== 'object' || Array.isArray(db.tasks)) fail('STATE_UNAVAILABLE');
    for (const [id, t] of Object.entries(db.tasks)) {
      if (!/^[a-f0-9]{64}$/.test(id) || t.id !== id || !/^[a-f0-9]{64}$/.test(t.namespace) || typeof t.text !== 'string' || Buffer.byteLength(t.text) > LIMITS.textBytes || !Number.isFinite(t.readyAt) || !['running', 'succeeded', 'cancelled'].includes(t.state)) fail('STATE_UNAVAILABLE');
    }
  });
  function observe(task) {
    if (task.state === 'running' && Date.now() >= task.readyAt) task.state = 'succeeded';
    return { taskId: task.id, state: task.state, observedAt: new Date().toISOString(),
      ...(task.state === 'succeeded' ? { result: { type: 'text', text: `[reference] ${task.text}` } } : {}),
      ...(task.cancelRequested ? { cancelRequested: true } : {}) };
  }
  function find(db, ctx, id) { const t = db.tasks[id]; if (!t || t.namespace !== ctx.namespace) fail('NOT_FOUND'); return t; }
  return {
    bindingId: 'reference/1',
    async describe(ctx) { return { contractVersion: CONTRACT_VERSION, provider: 'reference', publication: ctx.publication,
      operations: ['describe', 'submit', 'get', 'cancel'], input: { text: true, attachments: false }, output: { text: true, tokenStreaming: false },
      idempotency: { durable: true, retentionSeconds: null }, recovery: { lookupByRequestId: true }, cancellation: 'request-and-observe', humanHandoff: false }; },
    async submit(ctx, invocation) {
      return store.transaction(db => {
        const old = db.tasks[ctx.requestId];
        if (old) {
          if (old.namespace !== ctx.namespace || old.text !== invocation.input.text || old.conversationId !== ctx.conversationId) fail('IDEMPOTENCY_CONFLICT');
          return observe(old);
        }
        if (Object.keys(db.tasks).length >= 10000) fail('RATE_LIMITED');
        const task = { id: ctx.requestId, namespace: ctx.namespace, conversationId: ctx.conversationId, text: invocation.input.text, state: 'running', readyAt: Date.now() + delayMs };
        db.tasks[ctx.requestId] = task; return observe(task);
      });
    },
    async get(ctx, id) { return store.transaction(db => observe(find(db, ctx, id))); },
    async cancel(ctx, id) { return store.transaction(db => { const task = find(db, ctx, id); observe(task); if (task.state === 'running') { task.cancelRequested = true; task.state = 'cancelled'; } return observe(task); }); },
    close: () => store.close()
  };
}
