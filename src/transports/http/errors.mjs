// HTTP status binding for connector error codes (Kimi-owned).
// Published mapping for the alpha binding; the response body always carries
// the same { error: publicError(error) } document as every other route.
export function httpStatusForError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  switch (code) {
    case 'INVALID_ARGUMENT': return 400;
    case 'UNAUTHENTICATED': return 401;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'IDEMPOTENCY_CONFLICT': return 409;
    case 'REQUEST_IN_PROGRESS': return 409;
    case 'AUTHORITY_CHANGED': return 409;
    case 'UNSUPPORTED_CAPABILITY': return 422;
    case 'RATE_LIMITED': return 429;
    case 'UPSTREAM_OUTCOME_UNKNOWN': return 502;
    case 'INVALID_UPSTREAM_RESPONSE': return 502;
    case 'UPSTREAM_UNAVAILABLE': return 503;
    case 'STATE_UNAVAILABLE': return 500;
    case 'WAIT_TIMEOUT': return 504;
    case 'SHUTTING_DOWN': return 503;
    default: return 500;
  }
}

export function errorHeaders(error) {
  if (error && error.code === 'RATE_LIMITED' && Number.isFinite(error.retryAfterMs)) {
    return { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) };
  }
  return undefined;
}
