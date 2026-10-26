// Synthetic HTTP service authored from the public adapter contract. No private code.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
export async function createTeamBotFixture({ token = 'synthetic-fixture-token', publication = 'demo', botId = 'bot-demo', delayMs = 0 } = {}) {
  const tasks = new Map(), requestIds = new Set();
  const calls = { submit: 0, get: 0, cancel: 0, publication: 0 };
  const fault = { mode: null, revoked: false };
  const basePath = `/v1/bots/${publication}`;
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${token}` || fault.revoked) return json(403, { secret: 'do-not-echo-upstream' });
    if (fault.mode === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:1/never-follow' }); return res.end(); }
    if (req.url === basePath && req.method === 'GET') {
      calls.publication++;
      return json(200, { backend: 'openbot', publication: { id: publication, botId: fault.mode === 'wrong-publication' ? 'wrong-bot' : botId } });
    }
    if (req.url === `${basePath}/requests` && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, {}); }
      calls.submit++;
      if (requestIds.has(body.requestId)) return json(409, { error: 'fixture intentionally does not deduplicate POST' });
      requestIds.add(body.requestId);
      const receipt = `obt_${randomBytes(18).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
      tasks.set(receipt, { id: receipt, botId, status: delayMs ? 'running' : 'done', text: `fixture:${body.text}`, conversationId: body.conversationId, readyAt: Date.now() + delayMs });
      if (fault.mode === 'lost-submit') { req.socket.destroy(); return; }
      if (fault.mode === 'malformed-submit') { res.writeHead(200); res.end('{bad'); return; }
      return json(202, { request: snapshot(receipt) });
    }
    const rest = req.url?.startsWith(`${basePath}/requests/`) && req.url.slice(`${basePath}/requests/`.length);
    if (!rest) return json(404, {});
    const cancel = rest.endsWith('/cancel'), id = decodeURIComponent(cancel ? rest.slice(0, -7) : rest);
    if (!tasks.has(id) || fault.mode === 'not-found') return json(404, {});
    if (req.method === 'GET' && !cancel) {
      calls.get++;
      if (fault.mode === 'oversize') return json(200, { request: { ...snapshot(id), text: 'x'.repeat(200000) } });
      if (fault.mode === 'unknown-state') return json(200, { request: { ...snapshot(id), status: 'mystery', text: 'do-not-echo-upstream' } });
      if (fault.mode === 'wrong-id') return json(200, { request: { ...snapshot(id), id: 'another-task' } });
      return json(200, { request: snapshot(id) });
    }
    if (req.method === 'POST' && cancel) {
      calls.cancel++;
      const task = snapshot(id);
      if (task.status === 'running') tasks.get(id).status = 'canceled';
      return json(200, { request: snapshot(id) });
    }
    return json(405, {});
  });
  function snapshot(id) {
    const task = tasks.get(id);
    if (task.status === 'running' && Date.now() >= task.readyAt) task.status = 'done';
    const { readyAt, ...publicTask } = task;
    return publicTask;
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}${basePath}`, token, publication, botId, calls, fault, tasks,
    async close() { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; } };
}
