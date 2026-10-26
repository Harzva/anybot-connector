# Status

Updated: 2026-10-26. Version: `0.1.0-alpha.1`; contract: `anybot.connector/0.1`.

The runnable reference alpha is implemented. Core, reference/TeamBot providers,
HTTP, official MCP, the strict chat-completions channel and local CLI are present.
The public suite passes **64/64, zero skips**. See [verification](docs/VERIFICATION.md)
for exact evidence and remaining gates.

| Item | State |
| --- | --- |
| CXF / CXQwen consultation | Actual native replies received; accepted and corrected advice recorded |
| ZCode | Native model resolution failed before inference; no implementation attributed to it |
| Core / providers / CLI | Coordinator implemented after explicit user takeover authorization |
| HTTP / MCP / channel / independent interoperability tests | Native Kimi implementation, coordinator integration and corrections |
| Reference runtime and crash recovery | Contract-tested with durable state and actual CLI child processes |
| TeamBot adapter | 26 backend + 13 channel assertions passed against actual isolated services |
| HTTP / MCP equivalence | Same core, caller, request and task; official client handshake and stdio tests |
| Knocket text subset | Contract-tested; no real Knocket account acceptance |
| Independent third-party provider | Not yet implemented or independently adopted |
| npm publication / production deployment | Not performed; package remains private |

The user selected isolated backend acceptance for this milestone and will supply
real platform entry points later. A test enterprise with synthetic identities and
controlled model replies is separate from a real enterprise account or real Knocket
visitor/handoff acceptance. Publication ownership remains operator-asserted.

TeamBot returns an opaque receipt. A saved receipt survives connector restart;
losing the response before its receipt is persisted can leave a task running that
the connector cannot query or cancel. The connector reports outcome-unknown and
never silently replays the POST. Do not interpret a recovery handle as guaranteed
recovery. [Authority and recovery boundary](docs/HOST-INTEGRATION.md).
