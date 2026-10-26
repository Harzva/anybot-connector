import { createHash } from 'node:crypto';
import { ConnectorError, CONTRACT_VERSION, LIMITS } from '../../contract.mjs';
const fail = code => { throw new ConnectorError(code); };
const mapping = Object.freeze({ queued: 'accepted', running: 'running', done: 'succeeded', failed: 'failed', canceled: 'cancelled', interrupted: 'interrupted' });
export function createTeamBotProvider({ baseUrl, publication, token, operatorBinding, timeoutMs = 5000, maxResponseBytes = LIMITS.responseBytes } = {}) {
  if (!operatorBinding || operatorBinding.acknowledgeUnverifiedOwnership !== true || operatorBinding.publication !== publication || typeof operatorBinding.botId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(operatorBinding.botId)) fail('FORBIDDEN');
  let endpoint; try { endpoint = new URL(baseUrl); } catch { fail('INVALID_ARGUMENT'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol) ||
      (endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) ||
      typeof publication !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(publication) ||
      !endpoint.pathname.endsWith(`/v1/bots/${encodeURIComponent(publication)}`) || typeof token !== 'string' || !token.length || /[\r\n]/.test(token) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > LIMITS.responseBytes) fail('INVALID_ARGUMENT');
  const url = endpoint.href, botId = operatorBinding.botId;
  async function request(suffix, { body, signal, submit = false } = {}) {
    let response, timer; const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    try {
      response = await fetch(url + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) fail('UNAUTHENTICATED');
        if (response.status === 403) fail('FORBIDDEN');
        if (response.status === 404 && !submit) fail('NOT_FOUND');
        if (response.status >= 300 && response.status < 400) fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'INVALID_UPSTREAM_RESPONSE');
        fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE');
      }
      if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'INVALID_UPSTREAM_RESPONSE');
      const chunks = []; let count = 0;
      for await (const chunk of response.body) {
        count += chunk.length;
        if (count > maxResponseBytes) { controller.abort(); fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'INVALID_UPSTREAM_RESPONSE'); }
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'INVALID_UPSTREAM_RESPONSE'); }
    } catch (e) {
      await response?.body?.cancel().catch(() => {});
      if (e instanceof ConnectorError) throw e;
      fail(submit ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function verify(ctx) {
    const value = await request('', { signal: ctx.signal });
    if (value?.backend !== 'openbot' || value.publication?.id !== publication || value.publication?.botId !== botId) fail('FORBIDDEN');
  }
  function normalize(value, id) {
    const r = value?.request;
    if (!r || typeof r.id !== 'string' || r.id.length > 256 || !/^obt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(r.id) ||
        (id !== undefined && r.id !== id) || r.botId !== botId || !Object.hasOwn(mapping, r.status)) fail('INVALID_UPSTREAM_RESPONSE');
    const state = mapping[r.status];
    if (state === 'succeeded' && (typeof r.text !== 'string' || Buffer.byteLength(r.text) > LIMITS.responseBytes)) fail('INVALID_UPSTREAM_RESPONSE');
    if (r.cancelRequested !== undefined && typeof r.cancelRequested !== 'boolean') fail('INVALID_UPSTREAM_RESPONSE');
    return { taskId: r.id, state, observedAt: new Date().toISOString(),
      ...(state === 'succeeded' ? { result: { type: 'text', text: r.text } } : {}),
      ...(r.cancelRequested === undefined ? {} : { cancelRequested: r.cancelRequested }) };
  }
  async function operate(ctx, suffix, options, id) {
    await verify(ctx);
    let value;
    try { value = normalize(await request(suffix, { ...options, signal: ctx.signal }), id); }
    catch (e) { if (options?.submit && !['FORBIDDEN', 'UNAUTHENTICATED'].includes(e.code)) fail('UPSTREAM_OUTCOME_UNKNOWN'); throw e; }
    // Recheck publication withdrawal even for immediate terminal submissions.
    await verify(ctx); return value;
  }
  return {
    bindingId: createHash('sha256').update(JSON.stringify(['teambot-receipt/2', url, publication, botId])).digest('hex'),
    async describe(ctx) { await verify(ctx); return { contractVersion: CONTRACT_VERSION, provider: 'teambot', publication,
      operations: ['describe', 'submit', 'get', 'cancel'], input: { text: true, attachments: false }, output: { text: true, tokenStreaming: false },
      idempotency: { durable: false, retentionSeconds: null }, cancellation: 'request-and-observe', humanHandoff: false,
      recovery: { lookupByRequestId: false },
      limits: { textCodeUnits: 6000, nonWhitespace: true, noNul: true } }; },
    async submit(ctx, invocation) {
      const text = invocation.input?.text;
      if (typeof text !== 'string' || text.length > 6000 || !text.trim().length || text.includes('\0')) fail('INVALID_ARGUMENT');
      return operate(ctx, '/requests', { submit: true, body: { requestId: ctx.requestId, conversationId: ctx.conversationId, text } });
    },
    get: (ctx, id) => operate(ctx, `/requests/${encodeURIComponent(id)}`, {}, id),
    cancel: (ctx, id) => operate(ctx, `/requests/${encodeURIComponent(id)}/cancel`, { body: {} }, id)
  };
}
