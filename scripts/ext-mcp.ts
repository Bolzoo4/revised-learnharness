// scripts/ext-mcp.ts
/**
 * Entry of the read-only MCP server (stdio). Launched by the client:
 *   LH_DATA_DIR=<dir> npx tsx scripts/ext-mcp.ts [--knowledge-only]
 * Imports only the read-only layer (see tests/ext-mcp-closure.test.ts). Nothing
 * but protocol goes to stdout; diagnostics go to stderr.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { validateDataRoot } from "../src/store/ext/readonly.ts";
import { parseArgs } from "../src/server/ext/mcp/args.ts";
import { createMcpDeps } from "../src/server/ext/mcp/deps.ts";
import { createServer } from "../src/server/ext/mcp/server.ts";
import { installStdioGuard } from "../src/server/ext/mcp/stdio-guard.ts";

const guard = installStdioGuard();
const log = (message: string): void => void process.stderr.write(`[ext-mcp] ${message}\n`);

try {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const args = parseArgs(process.argv.slice(2), process.env, path.join(root, "data"));
	validateDataRoot(args.dataRoot);
	const server = createServer(createMcpDeps(args.dataRoot), { knowledgeOnly: args.knowledgeOnly, log });
	const transport = new StdioServerTransport(process.stdin, guard.protocolOut, { maxBufferSize: LIMITS.requestMaxBytes });
	await server.connect(transport);
	log(`ready (${args.knowledgeOnly ? "knowledge only" : "knowledge and study"})`);
} catch (error) {
	log(`cannot start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
