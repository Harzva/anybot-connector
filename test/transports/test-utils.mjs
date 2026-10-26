// Test utilities for Kimi's transport/channel suites (Kimi-owned).
// All worlds are synthetic: in-memory connector service, loopback HTTP only.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../../src/transports/http/index.mjs';
import { createMcpServer } from '../../src/transports/mcp/index.mjs';
import { createKnocketHandler } from '../../src/channels/knocket/index.mjs';
import { ConnectorError } from '../../src/contract.mjs';
import { createFakeService } from '../interoperability/fake-service.mjs';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Default host authentication for tests: identity comes from headers that
// stand in for host-side verification. 'nobody' denies authentication,
// 'mallory' is authenticated but can be denied by an authorize hook.
export function testAuthenticate(req) {
  const who = req.headers['x-test-user'];
  if (who === 'nobody' || who === undefined) return null;
  if (who === 'broken') throw new Error('auth backend down');
  const identity = { principal: String(who) };
  const visitor = req.headers['x-test-visitor'];
  if (visitor !== undefined) identity.endUserRef = String(visitor);
  return identity;
}

export async function startHttpWorld({
  connections,
  authorize,
  provider,
  authenticate = testAuthenticate,
  knocket,
} = {}) {
  const service = createFakeService({ connections, authorize, provider });
  const server = createHttpServer({ connector: service.connector, authenticate, knocket });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, path, { body, headers } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'alice',
        ...(headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, body: json, headers: response.headers };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await service.connector.close();
  }

  return { service, server, base, request, provider: service.provider, close };
}

// Starts an HTTP world whose /v1/chat/completions delegates to a real
// Knocket handler bound to the world's connector.
export async function startKnocketWorld(options = {}) {
  const service = createFakeService({
    connections: options.connections,
    authorize: options.authorize,
    provider: options.provider,
  });
  const knocket = createKnocketHandler({
    connector: service.connector,
    models: options.models ?? { 'demo-bot': 'conn-demo' },
    pollMs: options.pollMs ?? 5,
    waitMs: options.waitMs ?? 2000,
  });
  const server = createHttpServer({
    connector: service.connector,
    authenticate: options.authenticate ?? testAuthenticate,
    knocket,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  async function chat(body, { headers } = {}) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'alice',
        ...(headers || {}),
      },
      body: JSON.stringify(body),
    });
    let json;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, body: json, headers: response.headers };
  }
  async function request(method, path, { body, headers } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, body: json, headers: response.headers };
  }
  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await service.connector.close();
  }
  return { service, server, base, chat, request, provider: service.provider, close };
}

// Connects the OFFICIAL MCP client to a createMcpServer instance over the
// SDK InMemoryTransport pair, performing the real initialize handshake.
// Returns the negotiated protocol version as directly observed on the wire
// (the initialize result captured from the server transport's send path).
export async function connectMcpClient(connector, identity) {
  const server = createMcpServer({ connector, identity });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let negotiatedProtocolVersion;
  const originalSend = serverSide.send.bind(serverSide);
  serverSide.send = async (message) => {
    if (message && typeof message === 'object' && message.result && message.result.protocolVersion) {
      negotiatedProtocolVersion = message.result.protocolVersion;
    }
    return originalSend(message);
  };
  const client = new Client({ name: 'kimi-test-client', version: '0.0.0-test' });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const text = result?.content?.find((block) => block.type === 'text')?.text;
    let parsed;
    try {
      parsed = text === undefined ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { isError: result?.isError === true, result: parsed, raw: result };
  }

  async function close() {
    await client.close();
    await server.close();
  }

  return { client, server, call, close, getProtocolVersion: () => negotiatedProtocolVersion };
}

export { ConnectorError, createFakeService, createKnocketHandler };
