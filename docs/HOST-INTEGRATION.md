# Host integration and authority

The host owns credential verification. HTTP `authenticate(req)` returns a trusted
identity object; the same object reaches `authorize({operation,identity,connection})`.
An MCP stdio process receives its identity from its launching host, never from a
tool argument. Sharing a bearer token intentionally shares the calling principal;
that token cannot prove which visitor sent a message.

The bundled CLI reads a private JSON policy and token values from named environment
variables. On every operation and result disclosure it reloads the policy. Removing
an identity/operation/connection grant denies subsequent operations, including late
responses. Unreadable or malformed policy denies access. Route edits are rejected
as `AUTHORITY_CHANGED`; start a new immutable connection id instead of rebinding
old task handles. Environment changes outside a running process do not rotate its
tokens: remove the identity from policy immediately, then restart with new secrets.

HTTP listens only on literal `127.0.0.1`. A separate ephemeral loopback control
socket implements CLI shutdown; its random control secret stays in the private
state directory. It is not a public administration endpoint. SIGINT/SIGTERM also
request shutdown. TLS, remote exposure, enterprise login, external identity claims,
rate limiting at an ingress, and production deployment remain host responsibilities.
The sample CLI is a local alpha harness, not an enterprise identity server.

## TeamBot boundary

The independent TeamBot adapter is designed against a fixed publication endpoint.
The host supplies a token and an explicit operator binding to publication/bot id.
The publication check rejects mismatched ids and upstream authorization failures.
Withdrawal detection depends on the upstream rejecting withdrawn grants; ids alone
cannot attest publication lifecycle or ownership. It cannot prove
enterprise membership or enterprise ownership of a publication. No automatic
enterprise discovery or verification is advertised. Do not connect real enterprise
data until that separate acceptance gate has evidence.

An isolated test of the real enterprise HTTP service with synthetic accounts and
controlled model output verifies that integration only. Operator-pinning a URL
and checking a member online do not jointly prove the publication belongs to that
enterprise. Keep those evidence levels separate. A shared channel token also
shares authority: independent conversations are not per-visitor access control.

## Recovery

The provider owns task state and output. The core's journal is a routing and retry
ledger, including private provider receipts. Protect it as service state and keep
both storage roots for recovery. An unknown submission is not a
failed task and is never automatically repeated as a new POST. Retain its returned
handle/request key and query the original request when the provider supports it.
TeamBot requires its server-issued receipt: if the response is lost before that
receipt is fsynced, the connector cannot query or cancel the task. It returns
outcome-unknown on the same handle without resubmitting; trusted operator
reconciliation is required. A recovery handle does not guarantee automatic
recovery. State-directory corruption or
an active writer lock must fail closed. On a single host, a stale lock is reclaimed only after the recorded PID is proven
absent, under a separate recovery guard. Live, reused, malformed or unknown owner
locks fail closed and require operator investigation. Do not delete such locks.

Alpha has no retention/garbage-collection automation, shared-volume multi-host
coordination, or automatic reconciliation that replays uncertain submissions.
A fixture's durability cannot certify another provider's storage guarantees.
