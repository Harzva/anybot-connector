// Knocket-compatible chat-completions channel, strict text subset (Kimi-owned).
//
// createKnocketHandler({ connector, models, pollMs = 20, waitMs = 5000 })
// returns (req, res, identity) => Promise<void> for the HTTP server to
// delegate POST /v1/chat/completions to. `models` maps FIXED public aliases
// to configured connection ids; unknown aliases are rejected.
//
// Accepted request body (exact fields): { model, messages, stream? }.
//   - stream, when present, must be false (token streaming is not offered;
//     there is no SSE and no fake stream).
//   - tools / functions / attachments / system / developer messages are
//     rejected with UNSUPPORTED_CAPABILITY, never silently dropped.
//   - messages: 1..64 entries of exactly { role: 'user'|'assistant', content:
//     string }, at least one user message; each content is nonempty and at
//     most 20000 UTF-8 bytes; serialized history at most 20000 UTF-8 bytes.
//   - any other top-level parameter is rejected with INVALID_ARGUMENT.
//
// History is serialized as explicitly untrusted text with role labels:
//   [user]\n<text>\n\n[assistant]\n<text>
// Role labels are data, never instructions; no caller-supplied role can
// escalate to system/developer policy.
//
// Request identity: the `Idempotency-Key` header maps to the connector
// requestKey (1..128 chars of [A-Za-z0-9_.:-]); absent header -> fresh UUID,
// so every independent request gets an isolated conversation context. Visitor
// identity is NEVER inferred from message text or a shared API key; the
// verified host `identity` is passed through unchanged.
//
// After submit, the handler polls connector.get every pollMs up to waitMs:
//   - succeeded  -> 200 with an OpenAI-style chat.completion JSON (no usage)
//   - failed / cancelled / interrupted -> 502 INVALID_UPSTREAM_RESPONSE
//     (provider-side failure is never fabricated into a success; raw
//     provider errors never reach the client)
//   - deadline   -> 504 WAIT_TIMEOUT with { error: { ..., recovery: handle } }
//     so the caller can recover the SAME task; a wait timeout is not a failure
//   - client disconnect -> polling stops; the task is left untouched (no
//     resubmission, no pretend cancellation)
//
// Alpha limits are deliberately narrow and published here: 64 messages,
// 20000 bytes per message, and at most 20000 bytes of serialized history so
// the whole serialized input fits the core text limit; 65536-byte request
// body (enforced by the HTTP server), pollMs >= 1, waitMs <= 60000.
// Live Knocket platform behavior remains unverified; this module only
// implements the documented contract subset against the connector.
import { randomUUID } from 'node:crypto';
import { publicError, ConnectorError, LIMITS, TERMINAL_STATES } from '../../contract.mjs';
import { readBoundedBody, parseJsonBody } from '../../transports/http/body.mjs';
import { httpStatusForError, errorHeaders } from '../../transports/http/errors.mjs';
import { utf8Bytes, isPlainObject, validateIdentity, validateReference } from '../../transports/common/validate.mjs';

const MAX_MESSAGES = 64;
const SERIALIZED_HISTORY_LIMIT = LIMITS.textBytes;

const JSON_TYPE = 'application/json; charset=utf-8';

function invalid(detail) {
  const error = new ConnectorError('INVALID_ARGUMENT');
  error.detail = detail;
  return error;
}

function unsupported(detail) {
  const error = new ConnectorError('UNSUPPORTED_CAPABILITY');
  error.detail = detail;
  return error;
}

function writeJson(res, status, value, extraHeaders) {
  // Never write to a finished or torn-down connection (late success after
  // client disconnect must vanish, not crash or corrupt the socket).
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function writeError(res, error) {
  if (res.writableEnded) return;
  const safe = error instanceof ConnectorError ? error : new ConnectorError('STATE_UNAVAILABLE');
  writeJson(res, httpStatusForError(safe), { error: publicError(safe) }, errorHeaders(safe));
}

function validateAliasMap(models) {
  if (!isPlainObject(models)) throw new TypeError('models must map alias -> connectionId');
  const map = new Map();
  for (const [alias, connectionId] of Object.entries(models)) {
    validateReference(alias, 'model alias');
    validateReference(connectionId, 'model connection id');
    map.set(alias, connectionId);
  }
  return map;
}

function validateChatBody(body) {
  if (!isPlainObject(body)) throw invalid('body must be an object');
  if (Object.hasOwn(body, 'tools')) throw unsupported('tools are not supported');
  if (Object.hasOwn(body, 'functions')) throw unsupported('functions are not supported');
  for (const key of Object.keys(body)) {
    if (key !== 'model' && key !== 'messages' && key !== 'stream') throw invalid(`unknown parameter: ${key}`);
  }
  if (typeof body.model !== 'string' || body.model.length === 0 || body.model.length > LIMITS.referenceLength) {
    throw invalid('model must be a nonempty string of at most 128 characters');
  }
  if (Object.hasOwn(body, 'stream')) {
    if (body.stream === true) throw unsupported('stream=true is not supported; this binding returns one final result');
    if (body.stream !== false) throw invalid('stream must be a boolean');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('messages must be a nonempty array');
  if (body.messages.length > MAX_MESSAGES) throw invalid(`messages is limited to ${MAX_MESSAGES} entries`);
  let userCount = 0;
  const serialized = [];
  for (const message of body.messages) {
    if (!isPlainObject(message)) throw invalid('each message must be an object');
    for (const key of Object.keys(message)) {
      if (key !== 'role' && key !== 'content') {
        if (key === 'attachments' || key === 'tool_calls' || key === 'function_call') throw unsupported(`message field ${key} is not supported`);
        throw invalid(`unknown message field: ${key}`);
      }
    }
    const { role, content } = message;
    if (typeof role !== 'string') throw invalid('message role must be a string');
    if (role !== 'user' && role !== 'assistant') {
      if (role === 'system' || role === 'developer') {
        throw unsupported(`${role} messages are not supported and cannot set policy`);
      }
      throw unsupported(`message role ${role} is not supported`);
    }
    if (typeof content !== 'string') {
      if (Array.isArray(content)) throw unsupported('attachment content is not supported');
      throw invalid('message content must be a string');
    }
    if (content.length === 0) throw invalid('message content must be nonempty');
    if (utf8Bytes(content) > LIMITS.textBytes) throw invalid(`message content exceeds ${LIMITS.textBytes} UTF-8 bytes`);
    if (role === 'user') userCount += 1;
    serialized.push(`[${role}]\n${content}`);
  }
  if (userCount === 0) throw invalid('at least one user message is required');
  const historyText = serialized.join('\n\n');
  if (utf8Bytes(historyText) > SERIALIZED_HISTORY_LIMIT) {
    throw invalid(`serialized history exceeds ${SERIALIZED_HISTORY_LIMIT} UTF-8 bytes`);
  }
  return historyText;
}

function idempotencyKeyFrom(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw invalid('duplicate Idempotency-Key headers are not accepted');
  // A present-but-empty header is ambiguous: reject instead of silently
  // starting a fresh conversation. The charset also excludes ',', so joined
  // duplicate headers are rejected by the reference check below.
  if (raw.length === 0) throw invalid('Idempotency-Key header must not be empty');
  return validateReference(raw, 'Idempotency-Key');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tracks premature client disconnect. A ServerResponse 'close' without a
// finished write means the connection died mid-wait; note req.destroyed is
// NOT a valid signal because a fully-read request stream also reports
// destroyed=true on current Node.
function trackDisconnect(res) {
  let disconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) disconnected = true;
  });
  return () => disconnected;
}

function successPayload(alias, requestKey, snapshot) {
  if (!snapshot.result || snapshot.result.type !== 'text' || typeof snapshot.result.text !== 'string') {
    throw new ConnectorError('INVALID_UPSTREAM_RESPONSE');
  }
  return {
    id: `chatcmpl-${requestKey}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: snapshot.result.text },
      finish_reason: 'stop',
    }],
  };
}

export function createKnocketHandler({ connector, models, pollMs = 20, waitMs = 5000 } = {}) {
  if (!connector || typeof connector !== 'object') throw new TypeError('connector service is required');
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60000) throw new TypeError('pollMs must be an integer in [1, 60000]');
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 60000) throw new TypeError('waitMs must be an integer in [1, 60000]');
  const aliases = validateAliasMap(models);

  return async function knocketHandler(req, res, identity) {
    try {
      validateIdentity(identity);
      const declared = req.headers['content-type'];
      const mediaType = typeof declared === 'string' ? declared.split(';', 1)[0].trim().toLowerCase() : '';
      if (mediaType !== 'application/json') throw invalid('content-type must be application/json');
      const body = parseJsonBody(await readBoundedBody(req, LIMITS.bodyBytes));
      const historyText = validateChatBody(body);
      const connectionId = aliases.get(body.model);
      if (connectionId === undefined) {
        const error = new ConnectorError('NOT_FOUND');
        error.detail = `unknown model alias: ${body.model}`;
        throw error;
      }
      const requestKey = idempotencyKeyFrom(req) ?? randomUUID();
      const disconnected = trackDisconnect(res);

      const submitted = await connector.submit(identity, connectionId, {
        requestKey,
        input: { type: 'text', text: historyText },
      });

      let current = submitted;
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (disconnected()) return; // late success or facts never write after disconnect
        if (current.state === 'succeeded') {
          writeJson(res, 200, successPayload(body.model, requestKey, current));
          return;
        }
        if (TERMINAL_STATES.includes(current.state)) {
          throw new ConnectorError('INVALID_UPSTREAM_RESPONSE');
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ConnectorError('WAIT_TIMEOUT', { recovery: current.handle });
        }
        await sleep(Math.min(pollMs, remaining));
        if (disconnected()) return;
        // Bound the whole wait, not just the sleeps: a slow connector.get
        // cannot push the response past the deadline. The raced get keeps
        // running in the background; its late settlement is inert and never
        // resubmits, cancels, or writes anything.
        const budget = deadline - Date.now();
        if (budget <= 0) throw new ConnectorError('WAIT_TIMEOUT', { recovery: current.handle });
        const pending = connector.get(identity, current.handle)
          .then((snapshot) => ({ ok: snapshot }), (error) => ({ err: error }));
        let timer, settled;
        try {
          settled = await Promise.race([pending, new Promise(resolve => {
            timer = setTimeout(() => resolve({ timeout: true }), budget);
          })]);
        } finally { clearTimeout(timer); }
        if (settled.timeout) {
          pending.catch(() => {});
          throw new ConnectorError('WAIT_TIMEOUT', { recovery: current.handle });
        }
        if (settled.err) throw settled.err;
        current = settled.ok;
      }
    } catch (error) {
      writeError(res, error);
    }
  };
}
