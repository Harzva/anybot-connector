# Sources and reuse policy

The bootstrap documentation is an original design proposal. It does not vendor product code, private repository history, SDK source or agent transcripts.

## Standards to adopt or adapt

- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture): protocol and SDK foundations for tool/resource connections. Exact implemented protocol and SDK versions will be pinned when implementation begins.
- [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/): complementary responsibilities for tools and independent agents.
- [A2A specification](https://a2a-protocol.org/latest/specification/): evaluate existing task and capability semantics before defining new ones.
- [AG-UI introduction](https://docs.ag-ui.com/introduction): event-based agent/application interaction, including channel clients. Its scope overlaps some connector scenarios; this must be considered during architecture review.
- [Knocket AI Agent tutorial](https://knocket.trtc.io/tutorials/ai-agent/): integration reference to revalidate against the actual account and current product. The documentation link does not constitute a working integration or confirmation of general Developer API / webhook / MCP availability.

Standards retain their respective ownership and licenses. Any implementation dependency must add its version, license, provenance and update policy here or in a dedicated dependency manifest.

## Product adapters

TeamBot and OpenBot are intended providers. An adapter should use an explicitly documented interface and be independently implementable. Existing private implementations may inform interface verification in an authorized environment, but their source, bundled packages, credentials and development history are not automatically redistributable.

Before copying any existing code, record origin repository, exact revision, file paths, applicable license, retained notices, modifications and authorization to publish. If this cannot be established, implement the narrow adapter from the contract without copying that code.

## Evidence

An actual agent response is required before naming that agent as a reviewer or implementer. Public decision summaries may record reasoning and accepted findings; raw transcripts and local execution receipts remain outside this repository when they contain private context.
