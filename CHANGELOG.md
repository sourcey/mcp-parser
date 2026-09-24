# Changelog

All notable changes to `mcp-parser` are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [0.4.2] - 2026-09-24

### Added
- `snapshot({ protocolVersion })` and `mcp-parser snapshot --protocol-version` choose the protocol revision to request, so one server can be snapshotted at every revision it claims to serve.
- Stateless revisions (`2026-07-28` and later): the snapshot calls `server/discover` instead of `initialize`, carries the revision and client identity in `_meta` on every request, mirrors `Mcp-Method` and `Mcp-Name` into headers, and records the server's `supportedVersions` as `mcpVersions`.
- `MCP_FIRST_STATELESS_REVISION`, `isProtocolRevision`, and `isStatelessRevision` exports.

### Fixed
- After `initialize`, requests kept declaring the revision the client offered rather than the one the server negotiated. Every later request, the `initialized` notification included, now declares the negotiated revision.
- A refused HTTP request reported only its status. The error now carries the JSON-RPC error from the body, including the revisions a server says it supports.

## [0.4.1] - 2026-07-30

### Fixed
- `snapshot` requested protocol revision `2025-03-26` and never sent the `MCP-Protocol-Version` header. It now requests `2025-11-25` from a single exported constant and sends the header on both HTTP transports.
- Paginated `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` results were truncated to the first page without saying so. Every page is now followed, treating an empty-string cursor as a valid continuation, and a snapshot stopped by the page bound records `x-mcp-parser-incomplete` instead of presenting a partial list as complete.
- Streamable HTTP ignored server-minted sessions, so stateful servers failed after `initialize`. `Mcp-Session-Id` is now captured, echoed on later requests, and released on close.
- `clientInfo` reported a hardcoded version; it now comes from the package manifest.
- `McpIcon` was not re-exported, and icons were neither validated nor rendered.

### Added
- First tests for `snapshot`, covering all three transports against in-process servers.
- `MCP_PROTOCOL_VERSION`, `MCP_PARSER_CLIENT_INFO`, and `LIST_PAGE_LIMIT` exports.

### Changed
- README states the revision the client requests and the transports it implements, replacing a claim of support for all released protocol versions.

## [0.4.0] - 2026-05-10

### Added
- `mcp-parser generate --format markdown` for explicit markdown reference generation.

### Changed
- `mcp-parser generate` now defaults to markdown output instead of `llms-txt`, matching the package's docs-first positioning. Use `--format llms-txt` or `--format llms-full-txt` for context export files.
- README, package metadata, and generator docs now frame `llms.txt` as a compatibility/context export rather than the primary output.

## [0.3.1] - 2026-04-21

### Changed
- Bumped `mcp-schema` dependency to `^0.3.1`.
- Bumped `typescript` to `^5.9.0`, `vitest` to `^3.2.0`, and `@types/node` to `^22.19.17`.

### Fixed
- Stale `mcp-spec` package-name references in doc comments and README examples carried over from the pre-rename package.

## [0.3.0] - 2026-04-06

### Added
- Richer validator diagnostics: duplicate tool/resource/prompt names, whitespace in names, uppercase-name warnings, `inputSchema.required` consistency, URI scheme checks, template-variable checks, and prompt-argument validation.

### Changed
- Bumped `mcp-schema` to `^0.3.0`.

## [0.2.0] - 2026-04-06

### Added
- SSE and streamable HTTP transports for `snapshot`, matching the MCP spec's full transport set.
- Full test suite and GitHub Actions CI matrix (Node 20, 22, 24).
- Badges and protocol-version compatibility table in the README.

### Changed
- Renamed internal `mcp-spec` dependency to `mcp-schema`.

## [0.1.0] - 2026-04-02

### Added
- Initial release: `parse` / `parseString`, `validate`, `snapshot` (stdio), and generators for `llms.txt`, `llms-full.txt`, and markdown. CLI wrapper with `parse`, `validate`, `snapshot`, and `generate` commands.
