export const CONTRACT_VERSION = 'anybot.connector/0.1';
export const STATES = Object.freeze(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const LIMITS = Object.freeze({ textBytes: 20000, referenceLength: 128, bodyBytes: 65536, responseBytes: 131072 });
const messages = Object.freeze({
  INVALID_ARGUMENT: 'Invalid request.', UNAUTHENTICATED: 'Authentication required.',
  FORBIDDEN: 'Operation denied.', NOT_FOUND: 'Task or connection not found.',
  UNSUPPORTED_CAPABILITY: 'Capability not supported.', IDEMPOTENCY_CONFLICT: 'Request key already used for different input.',
  REQUEST_IN_PROGRESS: 'Original submission is unresolved.', RATE_LIMITED: 'Capacity exceeded.',
  UPSTREAM_UNAVAILABLE: 'Provider unavailable.', UPSTREAM_OUTCOME_UNKNOWN: 'Submission outcome unknown; recover the original request.',
  INVALID_UPSTREAM_RESPONSE: 'Invalid provider response.', AUTHORITY_CHANGED: 'Connection authority changed.',
  STATE_UNAVAILABLE: 'Required state unavailable.', WAIT_TIMEOUT: 'Waiting ended; task outcome is unchanged.',
  SHUTTING_DOWN: 'Connector is shutting down.'
});
export class ConnectorError extends Error {
  constructor(code, { retryable = false, recovery = undefined } = {}) {
    super(messages[code] ?? messages.INVALID_UPSTREAM_RESPONSE);
    this.name = 'ConnectorError';
    this.code = Object.hasOwn(messages, code) ? code : 'INVALID_UPSTREAM_RESPONSE';
    this.retryable = retryable === true;
    if (recovery !== undefined) this.recovery = recovery;
  }
}
export function publicError(error) {
  const safe = error instanceof ConnectorError ? error : new ConnectorError('STATE_UNAVAILABLE');
  return { code: safe.code, message: messages[safe.code], retryable: safe.retryable,
    ...(safe.recovery === undefined ? {} : { recovery: safe.recovery }) };
}
