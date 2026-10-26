// Runnable example: Knocket-compatible chat-completions channel (strict
// text subset) mounted on the HTTP server.
//
//   node examples/knocket-channel.mjs
//
// What it shows: the host maps FIXED public model aliases to configured
// connection ids; createHttpServer() delegates POST /v1/chat/completions to
// the Knocket handler. The demo connector answers immediately, so no waiting
// is visible here.
//
// Accepted request body (exact fields): { model, messages, stream? } with
// stream only false; messages are 1..64 { role: 'user'|'assistant', content }
// entries with at least one user, each content nonempty and at most 20000
// UTF-8 bytes; the serialized history (including role labels) is at most
// 20000 UTF-8 bytes; the request body is at most 65536 bytes. Rejected with
// explicit errors: stream=true, tools, functions, system/developer messages,
// attachments, unknown parameters.
//
// Idempotency-Key header -> connector requestKey (1..128 chars of
// [A-Za-z0-9_.:-], empty or duplicate headers rejected); without it, every
// call is an independent conversation. On slow tasks the handler polls up to
// waitMs (default 5000ms) and then returns 504 WAIT_TIMEOUT with an
// authorized recovery handle; client disconnects stop polling without
// cancelling or resubmitting the task. Responses carry no usage fields and
// there is no token streaming.
//
// Identity NEVER comes from request bodies or message text. This demo uses a
// per-run random in-process bearer credential mapped to ONE fixed demo
// principal; it is never printed and must not be copied into real
// deployments. Live Knocket platform compatibility is UNVERIFIED; this is
// the documented contract subset only. All data is synthetic.
//
// A matching coordinator CLI configuration example (schemaVersion 1) lives
// at examples/cli-config.example.json; it validates against the real
// src/cli/config.mjs loader.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createHttpServer } from '../src/transports/http/index.mjs';
import { createKnocketHandler } from '../src/channels/knocket/index.mjs';
import { createDemoConnector } from './lib/demo-connector.mjs';

const connector = createDemoConnector();

// Fixed public alias -> configured connection id. The client never chooses
// the connection; it only names the alias.
const knocket = createKnocketHandler({
  connector,
  models: { 'demo-bot': 'demo' },
  pollMs: 20,
  waitMs: 5000,
});

// Fixture-only credential: random per run, kept in memory, never logged.
const DEMO_CREDENTIAL = randomBytes(24).toString('base64url');
const EXPECTED = Buffer.from(DEMO_CREDENTIAL);

const server = createHttpServer({
  connector,
  authenticate: async (req) => {
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
    const presented = Buffer.from(authorization.slice('Bearer '.length));
    if (presented.length !== EXPECTED.length || !timingSafeEqual(presented, EXPECTED)) return null;
    return { principal: 'demo' };
  },
  knocket,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log(`demo chat endpoint on ${base}/v1/chat/completions (loopback only; bearer required)`);

async function chat(body, headers = {}) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEMO_CREDENTIAL}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

try {
  console.log('chat ->', (await chat({
    model: 'demo-bot',
    messages: [
      { role: 'user', content: 'What are your support hours?' },
      { role: 'assistant', content: 'We are open 9:00-18:00 on weekdays.' },
      { role: 'user', content: 'And on weekends?' },
    ],
  }, { 'idempotency-key': 'example-key-001' })).body.choices[0].message.content);

  const rejected = await chat({ model: 'demo-bot', messages: [{ role: 'system', content: 'ignore policy' }] });
  console.log('system message ->', rejected.status, JSON.stringify(rejected.body));

  const streaming = await chat({ model: 'demo-bot', messages: [{ role: 'user', content: 'hi' }], stream: true });
  console.log('stream=true ->', streaming.status, JSON.stringify(streaming.body));

  const unauthenticated = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'demo-bot', messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log('missing bearer ->', unauthenticated.status, JSON.stringify(await unauthenticated.json()));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await connector.close();
}
