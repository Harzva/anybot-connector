# Alpha implementation API (frozen for 0.1)

Node >=22.16, ESM `.mjs`; no build step. Contract `anybot.connector/0.1`.
Only text, one process per state directory. Single-host filesystem durability; no
multi-host store, expiration, automatic uncertain POST replay or token streaming.
Errors and constants are exported by `src/contract.mjs` (coordinator-owned).

## Core exports: `src/core/index.mjs`

`await createConnector({ stateDir, connections, authorize, operationTimeoutMs=10000 })` returns a service:

- `await describe(identity, connectionId)` -> descriptor
- `await submit(identity, connectionId, invocation)` -> task snapshot
- `await get(identity, handle)` -> task snapshot
- `await cancel(identity, handle)` -> task snapshot
- `await close()` -> stop admission, drain in-flight calls, release own writer lock

`identity` is host verified `{principal, endUserRef?}`. Both are bounded nonempty
strings. HTTP JSON cannot establish identity. `authorize({operation,identity,
connection})` MUST return `true` or throw/return false to deny. It runs before
provider work AND before disclosure, including immediate submit and cancel.
Failure is fail-closed. Pass the original host identity object to authorize (host proof may be held in a WeakMap). Trusted connection: `{id, revision, publication, grantId,
provider}`. Strings are nonempty, <=128 characters; route identity is immutable.
The provider object is configured by the host, never supplied by client JSON.

Invocation exact fields: `{ requestKey?, conversationRef?, input: {type:'text',
text} }`. No unknown fields. Refs use `[A-Za-z0-9_.:-]{1,128}`. Text is nonempty,
<=20000 UTF-8 bytes. Missing key uses UUID, returned in the snapshot. Missing
conversation defaults to the request key. Canonical payload is JSON of the array
`[conversationRef, 'text', text]`, after these explicit defaults. Distinguish case;
no trimming of accepted content. Same key with changed payload conflicts.

Provider descriptors may narrow input through `limits`: optional positive integer
`textBytes` and `textCodeUnits` (JavaScript UTF-16 string length), plus optional
boolean `nonWhitespace` and `noNul`. The effective byte ceiling never exceeds
20000. Core validates the complete input against these constraints before
journaling or dispatch; rejection does not consume a request key. No implicit
truncation or trimming occurs. TeamBot declares 6000 UTF-16 units, non-whitespace
content and no NUL; these apply to the entire serialized channel history too.

Opaque task snapshot: `{handle,requestKey,state,observedAt,result?,cancelRequested?}`.
`observedAt` is ISO time. `result` is `{type:'text',text}` only on succeeded; no raw
provider error. Handles must not disclose identity, endpoint or credentials.
All ownership checks include both principal and endUserRef. Denied handle access
returns NOT_FOUND. No input-required until a resume contract exists.

The core persists ONLY route/correlation metadata and payload digests, not task
results or user text. It also stores the private upstream task receipt when one
has been validated. Before POST, atomically fsync a PREPARED/SUBMITTING record.
Same-key concurrent calls serialize. Once a POST might have happened, all retry
and restart recovery use GET with the saved provider task ID, or the deterministic
submission ID only when the provider explicitly supports lookup by that ID.
Every provider descriptor must declare `recovery:{lookupByRequestId:boolean}`;
an absent or malformed declaration fails closed. The mode is journaled before
dispatch. A validated provider receipt is fsynced before disclosing a submission
response. For receipt-required providers with no saved receipt, get, cancel and
same-key retry return authorized outcome-unknown without querying a fabricated ID.
404 is outcome-unknown, never permission to re-submit. Persistence corruption,
write failure, or a second process holding the state directory fails closed. Single-host dead-PID locks may be reclaimed under a recovery guard; unknown or live owners are never removed. Provider calls are bounded by operationTimeoutMs (1..60000); submission timeouts remain outcome-unknown.
Rebinding a connection id to changed revision/publication/grant fails
AUTHORITY_CHANGED. Changing the provider endpoint also requires a new revision.

Provider-facing namespace is SHA256(JSON.stringify([connection.id, revision,
publication, grantId, principal, endUserRef ?? null])). `requestId` is SHA256 of
JSON.stringify([namespace,requestKey]); `conversationId` similarly hashes
[namespace,conversationRef]. This documented mapping prevents cross-caller ID
collisions; public request keys remain case-sensitive and are never overwritten.

## Provider exports

`await createReferenceProvider({stateDir,delayMs=20})` from
`src/providers/reference/index.mjs`. Owns its durable task facts; deterministic
result text prefixed `[reference] `. Never calls a model. Completion may be
computed from durable accepted time on observation; cancellation uses final
provider facts. Storage failure cannot return a success. One writer enforced.
No timer should continue after `await provider.close()`.

`createTeamBotProvider({baseUrl,publication,token,operatorBinding,timeoutMs=5000,
maxResponseBytes=131072})` from `src/providers/teambot/index.mjs`. `baseUrl` is the
fixed publication endpoint, e.g. `https://example.test/v1/bots/demo`. Operator
binding must be `{publication,botId,acknowledgeUnverifiedOwnership:true}` with
matching publication, otherwise FORBIDDEN. This is NOT machine-verifiable
enterprise ownership. HTTPS required except literal loopback HTTP for fixtures;
no credentials in URL, redirects, dynamic URLs, or secret errors. Revalidate
publication status on every operation: GET base returns `{backend:'openbot',
publication:{id,botId}}`. This validates consistency only, not enterprise proof.

Provider methods: `describe(context)`, `submit(context,invocation)`,
`get(context,taskId)`, `cancel(context,taskId)`. Core builds context
`{namespace,requestId,conversationId}`; requestId is the submission correlation ID.
The returned taskId may differ only when `lookupByRequestId:false`; it must be a
bounded `[A-Za-z0-9_.:-]{1,256}` provider receipt. The core stores it privately and
passes it to later get/cancel calls, requiring exact response-ID agreement. Adapter
snapshots use `taskId` in place of public `handle` and otherwise the same fields
(requestKey optional internally). Core validates every returned object.
TeamBot POST `base/requests` body `{requestId,conversationId,text}`; GET
`base/requests/:providerTaskId`; cancel POST same + `/cancel` body `{}`. Wrapper
`{request:{id,botId,status,text?,...}}`. Known status mappings: queued->accepted,
running->running, done->succeeded, failed->failed, canceled->cancelled,
interrupted->interrupted. TeamBot returns a signed opaque `obt_...` receipt,
not the submitted requestId. BotId must match; later observations must match the
saved receipt exactly. Unknown/oversize/malformed
responses fail. Network/timeout/malformed POST acceptance is outcome-unknown.
TeamBot declares `lookupByRequestId:false`. Losing its response, or crashing
before the receipt is saved, may leave an executing task that this connector
cannot query or cancel. It remains outcome-unknown and needs trusted operator
reconciliation; there is no automatic receipt-import or POST-replay path.
No claim of durable upstream idempotency without live evidence; journal suppresses
repeated POST. Abort, wait timeout and accepted cancellation never imply terminal
failure/cancellation. Static descriptors advertise no observe/handoff/streaming.

## Transport and channel exports (Kimi-owned)

`createHttpServer({connector,authenticate,knocket?})` from
`src/transports/http/index.mjs` returns an unstarted Node HTTP Server.
`authenticate(req)` returns a verified identity, or denies. It is a host callback,
not a body field. Routes: GET `/v1/connections/:id`, POST
`/v1/connections/:id/tasks`, GET `/v1/tasks/:handle`, POST
`/v1/tasks/:handle/cancel` (body `{}`). Success JSON is the descriptor/snapshot.
Errors are `{error:publicError(error)}`; bound body bytes, no raw exception leaks.
Unknown fields/methods reject. CLI binds loopback. No permissive CORS.

`createMcpServer({connector,identity})` from `src/transports/mcp/index.mjs`
returns the official SDK McpServer, ready for `.connect(transport)`. `identity`
is a trusted host identity (fixed per stdio session), NOT a tool argument. Tools:
`connector_describe({connectionId})`, `connector_submit({connectionId,...invocation})`,
`connector_get({handle})`, `connector_cancel({handle})`. JSON text content contains
the same facts/error as HTTP; errors have `isError:true`. Use official v2 SDK
server and client; no custom MCP implementation. Same process may serve HTTP and
MCP stdio; they use the SAME connector instance and state owner. Cross-interface
tests MUST use the official Client handshake and callTool, not direct callbacks.

`createKnocketHandler({connector,models,pollMs=20,waitMs=5000})` from
`src/channels/knocket/index.mjs` yields `(req,res,identity)=>Promise<void>`;
HTTP server delegates POST `/v1/chat/completions` when configured. `models` maps
fixed public aliases to connection ids. Allowed body: `model`, `messages`,
optional `stream:false`. Reject true, tools, functions, system/developer messages,
attachments, unknown parameters; messages only bounded user/assistant string
content, at least one user. Serialize history explicitly as untrusted text with
role labels; no role escalation. No usage fields or fake streaming. Request
Idempotency-Key may map to requestKey; otherwise UUID per call. Every independent
request gets isolated conversation context; do not infer visitor identity from
shared API key or message text. Same key uses stable context. Wait timeout returns
WAIT_TIMEOUT with authorized handle recovery; disconnect stops polling but never
resubmits or pretends to cancel. Live Knocket behavior remains unverified.

Imports: transports/channels may import contract constants/errors; they MUST NOT
import providers. Kimi may implement its own fake service in owned tests to avoid
same-source assumptions; shared `test/fixtures` stays coordinator-owned.

## Storage and observation limits

Each store is capped at 8 MiB and 10000 tasks. The reference provider retains facts without automatic expiry (`retentionSeconds:null`); TeamBot uses null for an unverified retention window and advertises durable=false. The adapter forwards current provider facts without inventing revisions: the checked TeamBot binding supplies no ordering version, so it cannot certify monotonic observations from a regressing upstream. The reference provider enforces immutable terminal facts in its own serial durable store.
