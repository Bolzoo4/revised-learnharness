// scripts/ext-mcp.ts
/**
 * Entry of the read-only MCP server (stdio). Launched by the client:
 *   LH_DATA_DIR=<dir> npx tsx scripts/ext-mcp.ts [--knowledge-only]
 * Imports only the read-only layer (see tests/ext-mcp-closure.test.ts). Nothing
 * but protocol goes to stdout; diagnostics go to stderr. The process exits when
 * the transport closes (an oversized request, a closed stdin, a dead stdout).
 */

// MUST stay the first import: it redirects stdout before any other module loads.
import { stdioGuard } from "../src/server/ext/mcp/stdio-install.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { validateDataRoot } from "../src/store/ext/readonly.ts";
import { parseArgs } from "../src/server/ext/mcp/args.ts";
import { createMcpDeps } from "../src/server/ext/mcp/deps.ts";
import { createServer } from "../src/server/ext/mcp/server.ts";

const log = (message: string): void => void process.stderr.write(`[ext-mcp] ${message}\n`);

try {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const args = parseArgs(process.argv.slice(2), process.env, path.join(root, "data"));
	validateDataRoot(args.dataRoot);
	const server = createServer(createMcpDeps(args.dataRoot), { knowledgeOnly: args.knowledgeOnly, log });
	// Set before connect: the transport closes on an oversized request, on end of stdin and on a fatal write, and the process must end then.
	server.server.onclose = () => process.exit(0);
	const transport = new StdioServerTransport(process.stdin, stdioGuard.protocolOut, { maxBufferSize: LIMITS.requestMaxBytes });
	await server.connect(transport);
	log(`ready (${args.knowledgeOnly ? "knowledge only" : "knowledge and study"})`);
} catch (error) {
	log(`cannot start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
