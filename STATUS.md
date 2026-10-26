# Status

Updated: 2026-10-26.

## Current delivery

- Original design documents, draft connector contract, implementation ownership and acceptance gates are prepared.
- The independent [AnyBot-Connector repository](https://github.com/Harzva/anybot-connector) is public and MIT-licensed.
- No private product code, credential, production record or private Git history is included in this initial document set.
- Bootstrap checks passed for local document links, code-fence balance, whitespace and accidental local-path / credential-shaped content. These are documentation checks, not runtime or security conformance tests.

## Pending work

| Item | State | Evidence required to change state |
| --- | --- | --- |
| CXF architecture consultation | Pending; not invoked | Actual response and coordinator decision record |
| ZCode core and provider implementation | Not started | Verified execution route, diff and passing assigned checks |
| Kimi transport and interoperability implementation | Not started | Verified execution route, diff and passing assigned checks |
| Runnable reference implementation | Not implemented | Clean-checkout quickstart and deterministic end-to-end tests |
| TeamBot adapter | Planned | Adapter tests plus separately authorized enterprise integration evidence |
| HTTP / MCP equivalence | Planned | Same caller, request and task facts across both interfaces |
| Knocket | Planned | Contract tests and separate real-account interoperability evidence |
| Independent provider portability | Planned | Implementation using the public contract without TeamBot internals |
| npm package / release | Not published | License audit, package-content audit, clean install and release decision |
| Production deployment | Not performed | Separate deployment scope and operational acceptance |

Architecture review, implementation and acceptance are separate gates. Preparing prompts or checking an installed executable is not an actual agent run.

## Evidence levels

Use `planned`, `implemented`, `contract-tested`, `fixture-integrated`, `live-platform-verified`, and `production-accepted` precisely. A level applies to a named feature and tested version, not to every capability of a product.
