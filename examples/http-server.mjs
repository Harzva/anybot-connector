// Runnable example: HTTP binding of the connector contract.
//
//   node examples/http-server.mjs
//
// What it shows: the host creates the connector service, plugs an
// authenticate() host callback into createHttpServer(), and binds the
// returned Node HTTP server (here on an ephemeral loopback port).
//
// Alpha limits enforced by the binding (published, narrow on purpose):
//   - request bodies: at most 65536 bytes, content-type application/json
//   - text input: nonempty, at most 20000 UTF-8 bytes
//   - requestKey/conversationRef: [A-Za-z0-9_.:-]{1,128}
//   - invocation has exactly { requestKey?, conversationRef?, input }
//   - errors are { error: { code, message, retryable } }; unknown fields,
//     routes and methods are rejected; no CORS headers
//
// Identity NEVER comes from the request body. This demo uses a per-run
// random in-process bearer credential mapped to ONE fixed demo principal:
// it exists only so the example is runnable, is never printed or persisted,
// and must not be copied into real deployments — those wire host-verified
// identity (mTLS, SSO, token introspection, ...) into authenticate().
// All data in this example is synthetic; the demo service is in-memory and
// non-durable, not for production use.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createHttpServer } from '../src/transports/http/index.mjs';
import { createDemoConnector } from './lib/demo-connector.mjs';

const connector = createDemoConnector();

// Fixture-only credential: random per run, kept in memory, never logged.
const DEMO_CREDENTIAL = randomBytes(24).toString('base64url');
const EXPECTED = Buffer.from(DEMO_CREDENTIAL);

async function authenticate(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const presented = Buffer.from(authorization.slice('Bearer '.length));
  if (presented.length !== EXPECTED.length || !timingSafeEqual(presented, EXPECTED)) return null;
  return { principal: 'demo' }; // one fixed demo principal for this run
}

const server = createHttpServer({ connector, authenticate });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log(`demo connector listening on ${base} (loopback only; bearer required)`);

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEMO_CREDENTIAL}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

try {
  console.log('describe ->', (await call('GET', '/v1/connections/demo')).body.operations);

  const submitted = await call('POST', '/v1/connections/demo/tasks', {
    requestKey: 'example-request-001',
    input: { type: 'text', text: 'What are your support hours?' },
  });
  console.log('submit ->', submitted.body);

  console.log('get ->', (await call('GET', `/v1/tasks/${submitted.body.handle}`)).body);

  const denied = await fetch(`${base}/v1/connections/demo`);
  console.log('missing bearer ->', denied.status, JSON.stringify(await denied.json()));

  const wrong = await fetch(`${base}/v1/connections/demo`, {
    headers: { authorization: 'Bearer not-the-demo-credential' },
  });
  console.log('wrong bearer ->', wrong.status, JSON.stringify(await wrong.json()));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await connector.close();
}
