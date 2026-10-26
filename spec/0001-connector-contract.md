# RFC 0001 — Connector contract

Status: **alpha contract frozen after actual architecture consultation**. Contract identifier: `anybot.connector/0.1`. See [implementation API](0002-alpha-api.md) and [decisions](../docs/ARCHITECTURE-REVIEW.zh-CN.md). This identifier is an internal adapter contract, not a claim of a new industry wire protocol.

The keywords MUST, SHOULD and MAY describe proposed requirements for this project. No implementation is certified by this document's publication.

## 1. Roles and trust boundaries

- **Provider**: owns bot execution, durable task facts and domain policy.
- **Provider adapter**: translates the provider's API into this contract.
- **Core**: validates operations and orchestrates trusted authorization and adapters.
- **Transport**: presents operations through HTTP, MCP or another explicitly supported binding.
- **Channel**: verifies application events and maps customer conversations to invocations.
- **Host**: supplies verified identity, approved configuration, credentials and lifecycle policy.

Extensions MUST NOT load arbitrary modules, upstream URLs or credentials from a client payload. Context received from a client is untrusted until verified by the host. A caller-supplied `tenantId`, `subject`, role or system message MUST NOT establish authority.

## 2. Connection and authority context

A trusted connection definition identifies a provider adapter, provider endpoint, publication, grant identity and configuration revision. Changing the target or effective grant identity creates a new routing namespace; it MUST NOT silently repoint existing task handles.

The host supplies an invocation context containing:

| Field | Meaning |
| --- | --- |
| `connectionId` | Immutable configured route namespace |
| `principal` | Verified calling application / credential identity |
| `endUserRef` | Optional verified, channel-scoped end-user reference |
| `authorityRef` | Opaque provider authorization reference; never a client-selected role |
| `configurationRevision` | Version used to detect policy or route changes |
| `signal` | Abort signal for the current operation, not proof of task cancellation |
| `assertAuthorized(operation)` | Trusted callback to recheck current authority |

Secrets remain in host-owned credential resolution. They MUST NOT appear in capability descriptions, task handles, protocol errors or audit payloads. Provider responses and capability declarations are parsed as untrusted data.

## 3. Capability descriptor

Example only:

```json
{
  "contractVersion": "anybot.connector/0.1",
  "provider": "reference",
  "publication": "support-demo",
  "operations": ["describe", "submit", "get", "cancel"],
  "input": {"text": true, "attachments": false},
  "output": {"text": true, "tokenStreaming": false},
  "idempotency": {"durable": true, "retentionSeconds": 86400},
  "cancellation": "request-and-observe",
  "humanHandoff": false
}
```

Descriptors MUST reflect the adapter plus provider's actual behavior. A declared capability is validated by conformance tests. Unknown capabilities default to unsupported. Connector limits may narrow provider limits and MUST be published. Descriptors MUST NOT disclose ungranted bots or capabilities.

The supported contract version, provider API version, binding version and tested implementation revision are recorded separately. Unsupported major versions fail explicitly. Extensions require a namespace, schema and documented fallback.

## 4. Provider operations

| Operation | Required | Input / outcome |
| --- | --- | --- |
| `describe(context)` | Yes | Authorized capability descriptor |
| `submit(context, invocation)` | Yes | Accepted task snapshot or structured error |
| `get(context, taskHandle)` | Yes | Current provider-confirmed task snapshot |
| `cancel(context, taskHandle)` | Capability-dependent | Request acknowledgement and last confirmed state |
| `observe(context, taskHandle, cursor)` | Capability-dependent | Documented provider events; polling may be a separate binding behavior |

Conceptual invocation fields:

```json
{
  "requestKey": "example-request-001",
  "conversationRef": "example-conversation-001",
  "input": {"type": "text", "text": "What are your support hours?"}
}
```

`conversationRef` is interpreted within the verified caller and connection namespace. References are validated for bounded size; a public reference is not a provider database ID or an authorization grant. Input limits and accepted fields are explicit. Unsupported attachments, roles or execution options MUST NOT be silently dropped.

Provider adapters may serialize bounded conversation context when a channel supplies history. The transformation and loss of semantics MUST be documented. External `system` or `developer` roles MUST NOT override provider policy. Missing stable channel identity is handled with independent request contexts, not guessed continuity.

## 5. Task snapshots and observations

Required task facts: opaque `handle`, provider-confirmed `state`, and an observation timestamp. Result text is present only when the provider supplies a completed result. Optional upstream revision and timestamps must preserve their provenance.

Proposed states: `accepted`, `running`, `input-required`, `succeeded`, `failed`, `cancelled`, `interrupted`. Providers declare which states they use. Unknown upstream states return an invalid-response error, not a fabricated completion. The adapter may preserve a safe provider state code for diagnostics without exposing raw upstream responses.

`cancelRequested` is a separate observation and does not imply `cancelled`. A timeout in the connector does not prove `failed`. An older observation MUST NOT overwrite a newer confirmed terminal state when ordering is available; without ordering the adapter MUST document the limitation and avoid inventing a sequence.

`input-required` is only useful when a resume/input contract exists; v0.1 adapters may explicitly reject providers needing it. Programmatic human handoff is an independent capability whose success requires the owning platform's confirmation.

## 6. Idempotency and recovery

The effective request namespace includes the immutable connection, verified caller, publication/grant identity and request key. The canonical payload includes every semantically relevant input field. Canonicalization rules MUST be stable across transports and versions and distinguish absent fields from meaningful values.

- Same namespace and same input: return the existing task or its current snapshot.
- Same namespace and different input: `IDEMPOTENCY_CONFLICT`.
- Concurrent submission with the same key: one upstream effect; other callers receive the same handle or an explicit in-progress response.
- Missing request key: create a key for this call; independent later calls are not automatically retries.
- Ambiguous upstream acceptance: `UPSTREAM_OUTCOME_UNKNOWN`; do not generate a fresh key and resubmit.
- Restart: recover the routing and request identity needed to find the original task; do not auto-replay uncertain submissions.
- Expiry: publish the deduplication window and behavior after expiry. Never promise unlimited exactly-once execution.

Use upstream durable idempotency where it is sufficient. Any connector journal records only routing and submission correlation, with atomic writes and explicit crash cases. It MUST NOT become a second independent task executor or authoritative outcome store.

## 7. Authority lifecycle

Recheck authorization before submission, before sensitive follow-up operations, during long-running observations at a bounded interval, and before disclosing a result. Cancellation of internal work may require a narrowly scoped control authority even after caller read access is revoked; that distinction must be documented and tested.

Removing a connection or revoking a caller blocks new operations and result disclosure. It does not prove that a remote task or external side effect was undone. Late replies cannot restore revoked authority. Connector shutdown stops admission, drains or cancels owned work where supported, and records unresolved task references.

## 8. Error model

Safe error fields: `code`, generic `message`, `retryable`, optional `retryAfterMs`, and optional authorized recovery reference. Never include credentials, internal prompts, customer content or raw provider error bodies.

| Code | Meaning | Automatic retry |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Invalid schema or limits | No |
| `UNAUTHENTICATED` | No valid calling identity | No |
| `FORBIDDEN` | Valid identity lacks authority | No |
| `NOT_FOUND` | Missing or non-disclosable resource | No |
| `UNSUPPORTED_CAPABILITY` | Operation or content not supported | No |
| `IDEMPOTENCY_CONFLICT` | Same key, different semantic request | No |
| `REQUEST_IN_PROGRESS` | Original matching submission unresolved | Query same request |
| `RATE_LIMITED` | Local/provider limit reached | Only if no submission effect is ambiguous |
| `UPSTREAM_UNAVAILABLE` | Upstream unavailable before known acceptance | According to operation semantics |
| `UPSTREAM_OUTCOME_UNKNOWN` | Acceptance/result cannot be established | Recover original request only |
| `INVALID_UPSTREAM_RESPONSE` | Invalid shape, state, binding or excessive response | No blind resubmission |
| `AUTHORITY_CHANGED` | Grant, policy or configuration changed | Reauthorize; do not auto-repeat work |
| `STATE_UNAVAILABLE` | Required recovery state unavailable | No unsafe continuation |

HTTP status and MCP error/result bindings must be specified in dedicated binding documents during implementation. A transport must preserve the meaning of unknown outcomes and denied authority.

## 9. Events and delivery

True token streaming is optional and separately advertised from a one-shot final result delivered using SSE. A polling event stream MUST identify its semantics; it cannot claim token-level generation.

Where events are supported, define task handle, event ID/cursor, kind, payload, ordering, replay retention and duplicate handling. Reconnection resumes observation; it MUST NOT resubmit the task. Bound buffering and slow-client behavior. Raw chain-of-thought is outside the output contract.

## 10. Conformance and exclusions

See the [acceptance matrix](../docs/ACCEPTANCE.zh-CN.md). A reference fixture is not proof of enterprise admission, a real LLM, a real customer channel or independent third-party adoption.

v0.1 excludes arbitrary code execution plugins, dynamic remote module loading, model-key forwarding to channels, automatic cross-tenant discovery, distributed scheduling, billing and an unrestricted MCP proxy. Optional features remain unsupported until their adapter and acceptance evidence exist.
