// Shared input validation for the HTTP and MCP bindings (Kimi-owned).
// Both bindings validate client input at the edge so that error facts stay
// identical across transports; the core re-validates authoritatively.
import { ConnectorError, LIMITS } from '../../contract.mjs';

const REF_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const BYTE_LIMIT = LIMITS.textBytes;

export function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message) {
  // Generic public message by design; details never reach the client.
  const error = new ConnectorError('INVALID_ARGUMENT');
  error.detail = message;
  return error;
}

export function validateIdentity(identity) {
  if (!isPlainObject(identity)) throw new ConnectorError('UNAUTHENTICATED');
  const { principal, endUserRef } = identity;
  if (typeof principal !== 'string' || principal.length === 0 || principal.length > LIMITS.referenceLength) {
    throw new ConnectorError('UNAUTHENTICATED');
  }
  if (endUserRef !== undefined && (typeof endUserRef !== 'string' || endUserRef.length === 0 || endUserRef.length > LIMITS.referenceLength)) {
    throw new ConnectorError('UNAUTHENTICATED');
  }
  return identity;
}

export function validateConnectionId(connectionId) {
  if (typeof connectionId !== 'string' || !REF_PATTERN.test(connectionId)) {
    throw invalid('connectionId must match [A-Za-z0-9_.:-]{1,128}');
  }
  return connectionId;
}

export function validateHandle(handle) {
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 256) {
    throw invalid('handle must be a nonempty string of at most 256 characters');
  }
  return handle;
}

export function validateReference(value, name) {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
    throw invalid(`${name} must match [A-Za-z0-9_.:-]{1,128}`);
  }
  return value;
}

function validateInput(input) {
  if (!isPlainObject(input)) throw invalid('input must be an object');
  const keys = Object.keys(input);
  for (const key of keys) {
    if (key !== 'type' && key !== 'text') throw invalid(`unknown input field: ${key}`);
  }
  if (input.type !== 'text') throw invalid("input.type must be 'text'");
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw invalid('input.text must be a nonempty string');
  }
  if (utf8Bytes(input.text) > BYTE_LIMIT) {
    throw invalid(`input.text exceeds ${BYTE_LIMIT} UTF-8 bytes`);
  }
  return { type: 'text', text: input.text };
}

// Exact contract invocation: { requestKey?, conversationRef?, input: { type:'text', text } }.
export function validateInvocation(body) {
  if (!isPlainObject(body)) throw invalid('invocation must be an object');
  for (const key of Object.keys(body)) {
    if (key !== 'requestKey' && key !== 'conversationRef' && key !== 'input') {
      throw invalid(`unknown field: ${key}`);
    }
  }
  const invocation = { input: validateInput(body.input) };
  if (body.requestKey !== undefined) invocation.requestKey = validateReference(body.requestKey, 'requestKey');
  if (body.conversationRef !== undefined) invocation.conversationRef = validateReference(body.conversationRef, 'conversationRef');
  return invocation;
}

// HTTP cancel bodies must be exactly {}; MCP cancel args must be exactly { handle }.
export function assertNoExtraFields(body, allowed) {
  if (!isPlainObject(body)) throw invalid('body must be an object');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(`unknown field: ${key}`);
  }
}
