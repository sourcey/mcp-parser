# Changelog

All notable changes to `mcp-parser` are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

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
