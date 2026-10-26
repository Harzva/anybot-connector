// Runnable example: MCP binding with the official SDK client.
//
//   node examples/mcp-server.mjs
//
// What it shows: createMcpServer() returns the official
// @modelcontextprotocol/server McpServer; the host fixes ONE trusted
// identity per server and connects any SDK transport. This example uses the
// SDK InMemoryTransport pair plus the real @modelcontextprotocol/client
// handshake. The coordinator CLI connects the same server object to
// StdioServerTransport for `anybot-connector` stdio mode.
//
// Tool surface (alpha): connector_describe / connector_submit /
// connector_get / connector_cancel. Success results are JSON text with the
// descriptor/snapshot; errors have isError:true and the same
// { error: { code, message, retryable } } document as the HTTP binding.
// All data is synthetic; there are no credentials.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer, MCP_TOOL_NAMES } from '../src/transports/mcp/index.mjs';
import { createDemoConnector } from './lib/demo-connector.mjs';

const connector = createDemoConnector();

// The identity is TRUSTED and host-fixed for the lifetime of this server,
// never a tool argument.
const server = createMcpServer({ connector, identity: { principal: 'demo-host' } });

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'example-client', version: '0.0.0' });
await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
console.log('handshake done with', client.getServerVersion().name);

try {
  const tools = await client.listTools();
  console.log('tools ->', tools.tools.map((tool) => tool.name).sort().join(', '));
  console.log('expected ->', [...MCP_TOOL_NAMES].sort().join(', '));

  const submitted = await client.callTool({
    name: 'connector_submit',
    arguments: {
      connectionId: 'demo',
      requestKey: 'example-request-002',
      input: { type: 'text', text: 'Hello from MCP' },
    },
  });
  console.log('submit ->', submitted.content[0].text);

  const parsed = JSON.parse(submitted.content[0].text);
  const fetched = await client.callTool({ name: 'connector_get', arguments: { handle: parsed.handle } });
  console.log('get ->', fetched.content[0].text);

  const missing = await client.callTool({ name: 'connector_get', arguments: { handle: 'demo-999' } });
  console.log('guessed handle -> isError:', missing.isError, '|', missing.content[0].text);
} finally {
  await client.close();
  await server.close();
  await connector.close();
}
