/**
 * Protocol identity for this client.
 *
 * One source of truth: no other module may hardcode the protocol revision or
 * the package version. The client version is read from the package manifest so
 * it cannot drift from a release.
 */

import { createRequire } from "node:module";

const manifest = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

/**
 * The MCP protocol revision this client requests during `initialize`.
 *
 * Servers that support a different revision answer with their own; the
 * snapshot records whatever the server returns, never this value.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Reported as `clientInfo` during `initialize`. */
export const MCP_PARSER_CLIENT_INFO: { readonly name: string; readonly version: string } = {
  name: manifest.name,
  version: manifest.version,
};

/**
 * How many pages of a paginated list are followed before a snapshot records
 * itself as incomplete. Servers set page size, so this is a safety bound
 * rather than a result limit.
 */
export const LIST_PAGE_LIMIT = 50;
