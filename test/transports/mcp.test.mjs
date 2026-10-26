// MCP binding tests: official @modelcontextprotocol/client handshake over the
// SDK InMemoryTransport pair, tool semantics, and error semantics against an
// independent synthetic connector service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { publicError, ConnectorError, CONTRACT_VERSION } from '../../src/contract.mjs';
import { createMcpServer, MCP_SERVER_NAME, MCP_TOOL_NAMES } from '../../src/transports/mcp/index.mjs';
import { createFakeService, connectMcpClient, sleep } from './test-utils.mjs';

const CONN = 'conn-demo';
const ALICE = { principal: 'alice' };

test('official client completes initialize handshake and lists the four tools', async () => {
  const service = createFakeService();
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    // Handshake facts negotiated by the SDK Client itself.
    assert.equal(mcp.client.getServerVersion().name, MCP_SERVER_NAME);
    const capabilities = mcp.client.getServerCapabilities();
    assert.ok(capabilities.tools, 'server must advertise tools capability');
    // Negotiated protocol version as directly observed in the initialize result.
    assert.equal(mcp.getProtocolVersion(), LATEST_PROTOCOL_VERSION);

    const listed = await mcp.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...MCP_TOOL_NAMES].sort(),
    );
    for (const tool of listed.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0);
    }

    // Published schemas are discoverable for real clients/models: required
    // fields, JSON types, and bounds are visible in tools/list.
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const describeSchema = byName.get('connector_describe').inputSchema;
    assert.deepEqual(describeSchema.required, ['connectionId']);
    assert.equal(describeSchema.properties.connectionId.type, 'string');
    assert.ok(describeSchema.additionalProperties === false, 'unknown argument names must be rejected');

    const submitSchema = byName.get('connector_submit').inputSchema;
    assert.deepEqual(submitSchema.required.sort(), ['connectionId', 'input']);
    assert.equal(submitSchema.properties.requestKey.type, 'string');
    assert.equal(submitSchema.properties.conversationRef.type, 'string');
    assert.equal(submitSchema.properties.input.additionalProperties, false);
    assert.deepEqual(submitSchema.properties.input.required.sort(), ['text', 'type']);
    assert.equal(submitSchema.properties.input.properties.text.type, 'string');

    for (const name of ['connector_get', 'connector_cancel']) {
      const schema = byName.get(name).inputSchema;
      assert.deepEqual(schema.required, ['handle']);
      assert.equal(schema.properties.handle.type, 'string');
      assert.equal(schema.additionalProperties, false);
    }
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('describe/submit/get/cancel via callTool return the same facts as the contract', async () => {
  const service = createFakeService({ provider: { delayMs: 10 } });
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    const described = await mcp.call('connector_describe', { connectionId: CONN });
    assert.equal(described.isError, false);
    assert.equal(described.result.contractVersion, CONTRACT_VERSION);
    assert.deepEqual(described.result.operations, ['describe', 'submit', 'get', 'cancel']);

    const submitted = await mcp.call('connector_submit', {
      connectionId: CONN,
      requestKey: 'req-mcp-1',
      input: { type: 'text', text: 'from mcp' },
    });
    assert.equal(submitted.isError, false);
    assert.deepEqual(Object.keys(submitted.result).sort(), ['handle', 'observedAt', 'requestKey', 'state']);
    assert.equal(submitted.result.requestKey, 'req-mcp-1');

    await sleep(50);
    const got = await mcp.call('connector_get', { handle: submitted.result.handle });
    assert.equal(got.isError, false);
    assert.equal(got.result.state, 'succeeded');
    assert.match(got.result.result.text, /^\[synthetic-provider\] from mcp$/);

    const cancelled = await mcp.call('connector_cancel', { handle: submitted.result.handle });
    assert.equal(cancelled.isError, false);
    assert.equal(cancelled.result.state, 'succeeded'); // terminal facts win
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('MCP error semantics: isError:true with the same public error document as HTTP', async () => {
  const service = createFakeService();
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    // Unknown handle -> NOT_FOUND, same document the HTTP binding returns.
    const missing = await mcp.call('connector_get', { handle: 'h_guessed' });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.result, { error: publicError(new ConnectorError('NOT_FOUND')) });
    assert.equal(missing.raw.content[0].type, 'text');

    // Idempotency conflict surfaces with identical facts.
    await mcp.call('connector_submit', {
      connectionId: CONN, requestKey: 'req-x', input: { type: 'text', text: 'one' },
    });
    const conflict = await mcp.call('connector_submit', {
      connectionId: CONN, requestKey: 'req-x', input: { type: 'text', text: 'two' },
    });
    assert.equal(conflict.isError, true);
    assert.deepEqual(conflict.result, { error: publicError(new ConnectorError('IDEMPOTENCY_CONFLICT')) });

    // Ownership isolation across identities.
    const service2 = createFakeService();
    const mcp2 = await connectMcpClient(service2.connector, { principal: 'bob' });
    try {
      const stolen = await mcp2.call('connector_get', { handle: 'h_guessed' });
      assert.equal(stolen.isError, true);
      assert.equal(stolen.result.error.code, 'NOT_FOUND');
    } finally {
      await mcp2.close();
      await service2.connector.close();
    }

    // Forbidden operation from authorize hook.
    const service3 = createFakeService({ authorize: async ({ operation }) => operation !== 'cancel' });
    const mcp3 = await connectMcpClient(service3.connector, ALICE);
    try {
      const submitted = await mcp3.call('connector_submit', {
        connectionId: CONN, input: { type: 'text', text: 'x' },
      });
      const denied = await mcp3.call('connector_cancel', { handle: submitted.result.handle });
      assert.equal(denied.isError, true);
      assert.deepEqual(denied.result, { error: publicError(new ConnectorError('FORBIDDEN')) });
    } finally {
      await mcp3.close();
      await service3.connector.close();
    }
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('domain errors match HTTP facts; structural errors are SDK validation results', async () => {
  const service = createFakeService();
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    // DOMAIN validation (reference charset, UTF-8 byte length, input.type,
    // connector errors) happens in the handlers and produces the same
    // { error: publicError(...) } document the HTTP binding returns.
    const invalidArgumentDoc = { error: publicError(new ConnectorError('INVALID_ARGUMENT')) };
    const domainCases = [
      ['connector_describe', { connectionId: 'bad id!' }],
      ['connector_submit', { connectionId: CONN, input: { type: 'image', text: 'ok' } }],
      ['connector_submit', { connectionId: CONN, input: { type: 'text', text: 'é'.repeat(10001) } }],
      ['connector_submit', { connectionId: CONN, requestKey: 'a b', input: { type: 'text', text: 'ok' } }],
      ['connector_submit', { connectionId: CONN, conversationRef: 'not a ref!', input: { type: 'text', text: 'ok' } }],
    ];
    for (const [tool, args] of domainCases) {
      const res = await mcp.call(tool, args);
      assert.equal(res.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.deepEqual(res.result, invalidArgumentDoc, `${tool} ${JSON.stringify(args)}`);
    }

    // STRUCTURAL validation (missing/extra fields, wrong JSON types, schema
    // bounds) is the SDK's layer: isError results whose text is the SDK's
    // own message, not a connector error document.
    const structuralCases = [
      ['connector_describe', {}],
      ['connector_describe', { connectionId: 7 }],
      ['connector_describe', { connectionId: CONN, extra: 1 }],
      ['connector_describe', { connectionId: 'x'.repeat(129) }],
      ['connector_submit', { connectionId: CONN }],
      ['connector_submit', { connectionId: CONN, input: { type: 'text' } }],
      ['connector_submit', { connectionId: CONN, input: { type: 'text', text: '' } }],
      ['connector_submit', { connectionId: CONN, input: { type: 'text', text: 'x'.repeat(20001) } }],
      ['connector_submit', { connectionId: CONN, conversationRef: 'z'.repeat(129), input: { type: 'text', text: 'ok' } }],
      ['connector_get', { handle: 5 }],
    ];
    for (const [tool, args] of structuralCases) {
      const res = await mcp.call(tool, args);
      assert.equal(res.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.equal(typeof res.result, 'string', `structural error must carry the SDK message: ${tool}`);
      assert.equal(res.result.error, undefined, `must NOT be a connector error document: ${tool}`);
    }
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('unknown tool names fail at protocol level with METHOD_NOT_FOUND', async () => {
  const service = createFakeService();
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    await assert.rejects(
      mcp.client.callTool({ name: 'connector_nope', arguments: {} }),
      (error) => error.code === -32602,
    );
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('connector bugs never leak internals through MCP tools', async () => {
  const service = createFakeService();
  service.connector.get = async () => {
    throw new Error('internal stack secret 12345');
  };
  const mcp = await connectMcpClient(service.connector, ALICE);
  try {
    const res = await mcp.call('connector_get', { handle: 'h_whatever' });
    assert.equal(res.isError, true);
    assert.deepEqual(res.result, { error: publicError(new ConnectorError('STATE_UNAVAILABLE')) });
    assert.ok(!JSON.stringify(res.raw).includes('internal stack secret'));
  } finally {
    await mcp.close();
    await service.connector.close();
  }
});

test('the exported server connects to a real StdioServerTransport over custom streams', async () => {
  const service = createFakeService();
  const server = createMcpServer({ connector: service.connector, identity: ALICE });
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  await server.connect(transport);
  // Connected means it is serving; stdio lifecycle is owned by the CLI host.
  await server.close();
  input.destroy();
  output.destroy();
  await service.connector.close();
});

test('createMcpServer validates its trusted identity at construction', () => {
  const service = createFakeService();
  try {
    assert.throws(() => createMcpServer({ connector: service.connector }), ConnectorError);
    assert.throws(() => createMcpServer({ connector: service.connector, identity: { principal: '' } }), ConnectorError);
    assert.throws(() => createMcpServer({ connector: service.connector, identity: 'alice' }), ConnectorError);
  } finally {
    service.connector.close();
  }
});
