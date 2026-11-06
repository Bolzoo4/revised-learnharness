// tests/helpers/mcp-noisy-entry.ts
// The server entry, with the noisy module placed in its import chain AFTER the guard (the guarded case).
import "../../src/server/ext/mcp/stdio-install.ts";
import "./mcp-noisy-module.ts";
await import("../../scripts/ext-mcp.ts");
