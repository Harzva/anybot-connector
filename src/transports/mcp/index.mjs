// MCP binding for the connector contract, built on the official
// @modelcontextprotocol/server SDK (Kimi-owned).
//
// createMcpServer({ connector, identity }) returns the SDK McpServer, ready
// for `.connect(transport)` with either SDK InMemoryTransport (tests) or
// SDK StdioServerTransport (coordinator CLI wires stdio). `identity` is a
// TRUSTED host identity fixed for the server lifetime, never a tool argument.
//
// Tools: connector_describe / connector_submit / connector_get /
// connector_cancel. Success results carry JSON text content with the same
// descriptor/snapshot document the HTTP binding returns; domain errors carry
// `isError: true` and the same { error: publicError(error) } document.
//
// Validation is split in two layers, per the alpha binding decision:
//   - STRUCTURAL (SDK-owned, zod strict schemas published in tools/list so
//     real clients/models can discover shapes): argument must be an object
//     with exactly the declared fields, correct JSON types, and coarse
//     bounds. Violations return isError:true tool results whose text is the
//     SDK's own validation message — structural messages are the SDK's
//     responsibility and are NOT byte-identical to HTTP error documents.
//   - DOMAIN (these handlers): reference charset, UTF-8 byte length,
//     input.type === 'text', and every connector error. Violations return
//     the same { error: publicError(error) } document the HTTP binding
//     returns for identical input.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { publicError, ConnectorError, LIMITS } from '../../contract.mjs';
import {
  validateIdentity,
  validateConnectionId,
  validateHandle,
  validateInvocation,
  assertNoExtraFields,
} from '../common/validate.mjs';

export const MCP_SERVER_NAME = 'anybot-connector';
export const MCP_SERVER_VERSION = '0.1.0-alpha.1';
export const MCP_TOOL_NAMES = Object.freeze([
  'connector_describe',
  'connector_submit',
  'connector_get',
  'connector_cancel',
]);

const refString = z.string().min(1).max(LIMITS.referenceLength);

const describeSchema = z.strictObject({ connectionId: refString });
const submitSchema = z.strictObject({
  connectionId: refString,
  requestKey: refString.optional(),
  conversationRef: refString.optional(),
  input: z.strictObject({
    type: z.string(),
    text: z.string().min(1).max(LIMITS.textBytes),
  }),
});
const handleSchema = z.strictObject({ handle: z.string().min(1).max(256) });

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(error) {
  const safe = error instanceof ConnectorError ? error : new ConnectorError('STATE_UNAVAILABLE');
  return { content: [{ type: 'text', text: JSON.stringify({ error: publicError(safe) }) }], isError: true };
}

function wrap(handler) {
  return async (args) => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createMcpServer({ connector, identity } = {}) {
  if (!connector || typeof connector !== 'object') throw new TypeError('connector service is required');
  const trustedIdentity = validateIdentity(identity);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'connector_describe',
    {
      description: 'Describe the capability descriptor of a configured connection. ' +
        'Argument: { connectionId: string } matching [A-Za-z0-9_.:-]{1,128}.',
      inputSchema: describeSchema,
    },
    wrap(async (args) => {
      assertNoExtraFields(args, ['connectionId']);
      return connector.describe(trustedIdentity, validateConnectionId(args.connectionId));
    }),
  );

  server.registerTool(
    'connector_submit',
    {
      description: 'Submit a text invocation. Arguments: { connectionId, requestKey?, conversationRef?, ' +
        "input: { type: 'text', text } }. requestKey/conversationRef match [A-Za-z0-9_.:-]{1,128}; " +
        'text is nonempty, at most 20000 UTF-8 bytes; unknown fields are rejected.',
      inputSchema: submitSchema,
    },
    wrap(async (args) => {
      assertNoExtraFields(args, ['connectionId', 'requestKey', 'conversationRef', 'input']);
      const connectionId = validateConnectionId(args.connectionId);
      const invocation = validateInvocation({
        requestKey: args.requestKey,
        conversationRef: args.conversationRef,
        input: args.input,
      });
      // Re-drop undefined optional fields so the core sees the exact contract shape.
      const clean = { input: invocation.input };
      if (invocation.requestKey !== undefined) clean.requestKey = invocation.requestKey;
      if (invocation.conversationRef !== undefined) clean.conversationRef = invocation.conversationRef;
      return connector.submit(trustedIdentity, connectionId, clean);
    }),
  );

  server.registerTool(
    'connector_get',
    {
      description: 'Fetch the current provider-confirmed snapshot of a task. Argument: { handle: string }.',
      inputSchema: handleSchema,
    },
    wrap(async (args) => {
      assertNoExtraFields(args, ['handle']);
      return connector.get(trustedIdentity, validateHandle(args.handle));
    }),
  );

  server.registerTool(
    'connector_cancel',
    {
      description: 'Request cancellation of a task. Argument: { handle: string }. ' +
        'The returned snapshot reflects provider-confirmed final facts.',
      inputSchema: handleSchema,
    },
    wrap(async (args) => {
      assertNoExtraFields(args, ['handle']);
      return connector.cancel(trustedIdentity, validateHandle(args.handle));
    }),
  );

  return server;
}
