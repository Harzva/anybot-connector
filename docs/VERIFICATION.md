# Alpha verification

Recorded 2026-10-26 for `0.1.0-alpha.1`, contract `anybot.connector/0.1`.
This report applies to the source delivered with it; private raw logs and model
receipts are retained outside the public repository.

## Public suite

Command: `npm test` (`node --test --test-timeout=15000 test/*/*.test.mjs`).
Node **22.22.3**, macOS arm64: **64 tests passed, 0 failed, 0 skipped**.
The explicit file glob excludes helper modules from the test count.

- Core: same-key concurrent submit, conflict, caller/end-user isolation, no body
  or result in its journal, explicit recovery capability, narrowed input limits,
  response loss, unknown 404, revocation before late disclosure, cancel/completion
  races, shutdown, route rebinding, corrupt state and storage-write failure.
- Actual child-process SIGKILL after provider acceptance verifies reference
  restart recovery and stale-lock handling without another POST.
- TeamBot synthetic HTTP: pinned endpoint and publication, redirect/malformed/
  oversized/unknown responses, opaque receipts, restart, missing-receipt outcome
  unknown, zero POST replay, cancellation and withdrawal.
- Input boundaries: 5999/6000/6001 UTF-16 units, Chinese and surrogate pairs,
  whitespace/NUL, complete serialized history. Rejected input creates no journal
  task and a corrected payload can reuse the key.
- HTTP/MCP: independent synthetic service and actual core/reference matrix,
  official initialization/tools-list/callTool, identical task facts and domain
  errors, separate principals and endUserRef values, bounded requests/timeouts.
- CLI: real child processes, official stdio client alongside HTTP, live policy
  revocation, shutdown and restart retaining the original handle.
- Channel: strict fields and messages, unsupported capabilities, same-key retry,
  timeout/disconnect, no invented success, streaming, usage or human handoff.

MCP packages: official server/client **2.4.0**. Observed negotiated protocol:
**2025-11-25**. Structural MCP errors remain SDK errors; they need not have the
same framing as HTTP domain errors.

## Clean installation and packaging

A fresh source snapshot with no dependency symlink was installed using
`npm ci --ignore-scripts`: 14 dependency packages installed successfully.
With Node **24.22.1**, the same explicit suite passed **64/64, zero skips**,
including the real CLI/stdio/restart test. The source, tests and examples match
the working source byte-for-byte. `npm run check` passed: public package paths,
14 dependency licenses and public-registry SHA-512 integrity entries audited.
These checks are not a security certification. See [licenses](DEPENDENCIES.md).

## Actual TeamBot backend

**26/26 backend assertions and 13/13 channel assertions passed.** Metadata and
summary log records are excluded from these counts. The private harness imports actual
TeamBot enterprise/BOT service code read-only, starts isolated Better Auth/SQLite
identity services and an actual gateway/executor, and supplies controlled local
model responses. Synthetic identities and data never establish a real enterprise
or real model-provider acceptance. No private implementation is redistributed.

The backend assertions cover describe, controlled-model completion, HTTP/MCP
same-handle facts, same-key retry without a second model effect, caller/end-user
isolation, no seeded employee history/memory in model input, enterprise policy
and member suspension, cancellation and grant withdrawal. Cancellation and
withdrawal wait until the held model request has actually started before acting.

The channel assertions exercise the actual channel → core → TeamBot → executor
chain, bounded complete history, same-key retry, distinct verified visitor
contexts, and denial of late output after member suspension/publication revocation.
The native Kimi session implemented these private harnesses; the coordinator
inspected their assertions, source provenance and result logs. Evidence digests
and public source hashes are recorded in [verification.json](verification.json).

The actual backend exposed two assumptions the initial synthetic fixture missed:
6000 UTF-16 input units and a service-issued opaque task receipt required for
get/cancel. Both contracts were corrected and covered by public regression tests.

## Remaining gates

The user chose to supply real test entry points later. Real TeamBot enterprise
publication ownership, real Knocket Test Connection/default fields, two real
visitors, platform retries and real human handoff/late-reply suppression are
unverified. No production service, formal desktop App or real user data was used.
A separate independent provider implementation and production operational
acceptance are also outstanding. No npm release is published.

Known receipt gap: after TeamBot accepts a task but before the connector persists
its receipt, response loss or process failure can strand an executing task.
The same public handle returns outcome-unknown; no fabricated lookup, cancellation
or repeat POST occurs. Manual trusted reconciliation is required. A public
recovery handle is not a promise that this upstream supports automatic recovery.
