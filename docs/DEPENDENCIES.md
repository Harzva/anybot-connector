# Dependency inventory

Initial lock: Node >=22.16, native ESM; npm lockfile v3, exact direct versions.
No private registry, product tarball, vendored SDK or install script is required.

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| @modelcontextprotocol/server | 2.4.0 | Apache-2.0 | Official MCP server and stdio transport |
| @modelcontextprotocol/client | 2.4.0 | Apache-2.0 | Development: real handshake/client verification |
| @modelcontextprotocol/core | 2.4.0 | Apache-2.0 | SDK transitive protocol implementation |
| zod | 4.6.7 | MIT | MCP schemas |

Lockfile transitives: cross-spawn 7.0.6, eventsource-parser 3.1.1, eventsource 3.0.7,
jose 6.2.13, path-key 3.1.1, pkce-challenge 5.0.1, shebang-command 2.0.0,
shebang-regex 3.0.0 and which 2.0.2 (MIT); isexe 2.0.0 (ISC).
`npm run check` verifies installed versions/licenses, public registry integrity
entries, package inclusion boundaries, and credential-shaped/local-path content.
This is a bounded packaging check, not a comprehensive security audit.

SDK source: [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
SDK v2 is the current stable line; its own exported supported protocol versions
and actual negotiated test version belong in the verification report. Node's
built-in HTTP, crypto, filesystem and test runner provide the rest of the runtime.
Updates require lock review and the same interoperability suite. No npm publish
or production deployment has been authorized; package remains `private: true`.
