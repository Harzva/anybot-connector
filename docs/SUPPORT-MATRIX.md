# Support matrix

Updated: 2026-10-26. Alpha `0.1.0-alpha.1`, contract `anybot.connector/0.1`.

| Component | Implemented | Verified scope | Live platform |
| --- | --- | --- | --- |
| Core text invocation / authority / durable correlation | Yes | Concurrency, isolation, revocation, crash, storage failure | Host integration required |
| Deterministic reference provider | Yes | Durable same-key lookup, terminal facts, cancel, restart | No model calls |
| TeamBot provider | Yes | Synthetic contract + 26 actual isolated backend assertions | Real enterprise pending |
| HTTP binding | Yes | Bounded input, error mapping, same core, actual loopback requests | No public deployment |
| MCP binding | Yes | SDK 2.4.0, observed protocol 2025-11-25, official client and stdio | No remote OAuth / Streamable HTTP |
| Knocket text subset | Yes | Contract tests + 13 actual backend channel assertions | Knocket account pending |
| OpenBot-specific provider | No | None | Pending |
| Independent third-party provider | No | None | Pending |
| A2A / AG-UI | No | None | Pending |
| Attachments / approvals / programmatic handoff | No | Explicit rejection | Pending |

Both providers expose describe/submit/get/cancel. Input is at most 20000 UTF-8
bytes; TeamBot additionally requires at most 6000 UTF-16 units, non-whitespace
text, and no NUL. The whole serialized channel history must fit. Cancellation is
request-and-observe; an acknowledgment or disconnected socket is not terminal
cancellation. All output is a complete text result, never token events.

Reference facts are retained without automatic expiry in its bounded durable
store. TeamBot retention/deduplication guarantees are not certified; the connector
journal prevents repeated POSTs. TeamBot needs the returned opaque receipt for
get/cancel. Missing receipt remains outcome-unknown, including after restart.
See [verification](VERIFICATION.md) and [bindings](../spec/0003-bindings.md).

Independent conversations do not establish visitor identities. Shared credentials
share authority unless a host supplies verified endUserRef values. Enterprise
publication ownership, actual Knocket request fields/retries, two real visitors,
and human handoff still require their own acceptance evidence.
