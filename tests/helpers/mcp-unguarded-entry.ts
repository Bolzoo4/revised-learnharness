// tests/helpers/mcp-unguarded-entry.ts
// The same chain with the noisy module FIRST: the control for the guarded case (its print must reach stdout).
import "./mcp-noisy-module.ts";
await import("../../scripts/ext-mcp.ts");
