// src/server/ext/mcp/stdio-install.ts
/**
 * Side effect on import: installs the stdout guard (stdio-guard.ts) before any
 * other module of the server loads. scripts/ext-mcp.ts imports this file FIRST,
 * so a module-level console.log or stdout write anywhere in the import chain
 * goes to stderr and never corrupts the protocol stream.
 */

import { installStdioGuard, type StdioGuard } from "./stdio-guard.ts";

export const stdioGuard: StdioGuard = installStdioGuard();
