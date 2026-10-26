// Demo connector service for the runnable examples ONLY.
//
// This is a minimal in-memory stand-in for the host-owned connector service
// (in production: `await createConnector({ stateDir, connections, authorize })`
// from src/core, which does not exist yet in this checkout). It implements
// the documented service surface { describe, submit, get, cancel, close }
// with deterministic synthetic results so the examples run anywhere:
// no state directory, no persistence, no network upstream, no model.
//
import { ConnectorError } from '../../src/contract.mjs';

// Results are prefixed "[demo] " and all data is synthetic by design.
// The service is in-memory and NON-DURABLE: tasks vanish when the process
// exits. It exists to make the examples runnable and is not suitable for
// production use, where the host-owned connector service (with its state
// directory and verified identity) must be used instead.

export function createDemoConnector({ publication = 'support-demo' } = {}) {
  const tasks = new Map();
  let nextId = 0;

  const descriptor = {
    contractVersion: 'anybot.connector/0.1',
    provider: 'demo-stub',
    publication,
    operations: ['describe', 'submit', 'get', 'cancel'],
    input: { text: true, attachments: false },
    output: { text: true, tokenStreaming: false },
    idempotency: { durable: true, retentionSeconds: 86400 },
    cancellation: 'request-and-observe',
    humanHandoff: false,
  };

  return {
    async describe(identity, connectionId) {
      assertIdentity(identity);
      if (typeof connectionId !== 'string' || connectionId.length === 0) {
        throw new ConnectorError('NOT_FOUND');
      }
      return descriptor;
    },
    async submit(identity, connectionId, invocation) {
      assertIdentity(identity);
      const text = invocation?.input?.text;
      if (typeof text !== 'string' || text.length === 0) {
        throw new ConnectorError('INVALID_ARGUMENT');
      }
      const handle = `demo-${(nextId += 1)}`;
      tasks.set(handle, {
        handle,
        requestKey: invocation.requestKey ?? 'demo-key',
        state: 'succeeded',
        result: { type: 'text', text: `[demo] You said: ${text}` },
      });
      return snapshot(tasks.get(handle));
    },
    async get(identity, handle) {
      assertIdentity(identity);
      const task = tasks.get(handle);
      if (!task) throw new ConnectorError('NOT_FOUND');
      return snapshot(task);
    },
    async cancel(identity, handle) {
      assertIdentity(identity);
      const task = tasks.get(handle);
      if (!task) throw new ConnectorError('NOT_FOUND');
      task.state = 'cancelled';
      delete task.result;
      return snapshot(task);
    },
    async close() {},
  };
}

function assertIdentity(identity) {
  if (typeof identity?.principal !== 'string' || identity.principal.length === 0) {
    throw new ConnectorError('UNAUTHENTICATED');
  }
}

function snapshot(task) {
  const base = {
    handle: task.handle,
    requestKey: task.requestKey,
    state: task.state,
    observedAt: new Date().toISOString(),
  };
  if (task.result) base.result = task.result;
  return base;
}
