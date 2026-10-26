# Alpha bindings

These bindings consume the [same service API](0002-alpha-api.md). Implementation
and test status remain in [STATUS](../STATUS.md); defining a wire mapping does not
certify any live platform.

## HTTP

All configured routes authenticate through the host callback. Bodies on submit
and cancel require `Content-Type: application/json`; the body limit is 65536 bytes.
Response JSON is the descriptor or task snapshot directly, without a second task
store. Responses use `Cache-Control: no-store`; no permissive CORS is installed.

| Method and path | Operation |
| --- | --- |
| GET `/v1/connections/:id` | describe |
| POST `/v1/connections/:id/tasks` | submit; exact invocation object |
| GET `/v1/tasks/:handle` | get |
| POST `/v1/tasks/:handle/cancel` | cancel; exact empty object `{}` |
| POST `/v1/chat/completions` | optional strict text channel |

Unknown routes and wrong methods return 404. Valid operations return 200 with
provider-confirmed state; a 200 submission response does not itself mean success.

Errors are `{error:{code,message,retryable,recovery?}}`. Generic public messages
exclude raw upstream data. Recovery is present only when authorized.

| HTTP status | Connector codes |
| --- | --- |
| 400 | INVALID_ARGUMENT |
| 401 | UNAUTHENTICATED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND |
| 409 | IDEMPOTENCY_CONFLICT, REQUEST_IN_PROGRESS, AUTHORITY_CHANGED |
| 422 | UNSUPPORTED_CAPABILITY |
| 429 | RATE_LIMITED |
| 500 | STATE_UNAVAILABLE |
| 502 | UPSTREAM_OUTCOME_UNKNOWN, INVALID_UPSTREAM_RESPONSE |
| 503 | UPSTREAM_UNAVAILABLE, SHUTTING_DOWN |
| 504 | WAIT_TIMEOUT |

Neither timeout nor client disconnect changes a task to failed/cancelled. Clients
recover the original task instead of silently choosing a fresh request key.

## MCP

Official SDK server/client packages are pinned to 2.4.0. The supported server
transport in the local CLI is stdio. In-process interoperability tests use the
SDK's paired transports and real initialization/tools-list/callTool exchanges.
The observed negotiated protocol version is `2025-11-25` with the pinned SDK.
Remote MCP Streamable HTTP, OAuth discovery and a general-purpose MCP proxy are
outside this alpha binding.

| Tool | Arguments |
| --- | --- |
| `connector_describe` | `{connectionId}` |
| `connector_submit` | `{connectionId,requestKey?,conversationRef?,input:{type:'text',text}}` |
| `connector_get` | `{handle}` |
| `connector_cancel` | `{handle}` |

Identity is fixed by the launching host and checked again by the core. A tool
argument cannot impersonate a principal. Tool success contains one text content
item encoding the same JSON facts as HTTP. Domain errors use `isError:true` and
one text item containing the same error document. MCP framing and structural
protocol errors remain the SDK's responsibility and may use protocol error
responses. No tool emits invented token events, usage counts or chain-of-thought.

## Knocket-compatible text subset

This is a candidate adapter, not a statement that a real Knocket account works.
The [platform tutorial](https://knocket.trtc.io/tutorials/ai-agent/) describes a
custom Chat Completions endpoint. Actual default fields, system messages,
timeouts, retry keys and visitor identity still require live inspection.

Only `model`, `messages` and optional `stream:false` are accepted. The fixed alias
map selects a connection. Messages are bounded user/assistant strings serialized
as data; system/developer roles, tools, functions, attachments, streaming and
unknown options reject explicitly. The whole serialized input must fit the core
text limit and the selected provider's narrower constraints before dispatch.
Responses contain a single completed assistant message and no usage
estimate. There is no SSE or programmatic handoff.

An explicit Idempotency-Key is scoped by the verified caller and connection.
Without it, each call has a fresh request/conversation identity. Supplied message
history is the only continuity in that mode; a shared API key does not identify a
visitor. A wait deadline returns WAIT_TIMEOUT with the original authorized task
handle. Disconnect stops observation and does not cancel or resubmit work.

Independent conversations prevent accidental context carryover; they do not
create separate access-control identities. Callers sharing a principal can query
that principal's known handles and reuse its request keys. Multi-visitor use needs
a host-verified `endUserRef`; do not infer it from client-supplied message text.
