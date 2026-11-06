// src/server/ext/mcp/server.ts
/**
 * The MCP server object (REQ-mcp-01, -02, -08, -10, -12). Every tool goes
 * through one safe wrapper:
 *   - a ToolError keeps its code and fixed message;
 *   - any other error (including an SDK or filesystem error) becomes the fixed
 *     `internal` failure, and the real error is logged on STDERR only;
 *   - a result above responseMaxBytes is refused, never truncated silently.
 * All tools are annotated readOnlyHint, closed-world and non-destructive.
 * Under --knowledge-only the study tools are not even registered.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { failureOf, INTERNAL_MESSAGE, ToolError, type ToolFailure } from "../../../core/ext/mcp/errors.ts";
import { LIMITS } from "../../../core/ext/mcp/limits.ts";
import type { McpDeps } from "../../../core/ext/mcp/ports.ts";
import { runTool, toolGroup, TOOL_NAMES } from "../../../core/ext/mcp/tools.ts";
import { CATALOG } from "./catalog.ts";

export const SERVER_NAME = "learning-platform";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
	knowledgeOnly: boolean;
	/** Where unexpected errors are logged. Must NEVER be stdout. */
	log?: (message: string) => void;
	/** The response ceiling; the default is LIMITS.responseMaxBytes (a test lowers it to reach the refusal). */
	responseMaxBytes?: number;
}

const INSTRUCTIONS =
	"Read-only access to a local learning knowledge base. No tool changes anything. Ids come from search_nodes, list_lectures or list_goals. Every list carries count and truncated; long text ends with a truncation marker.";

function asResult(payload: object, isError: boolean): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown>, isError };
}

export function safeCall(name: string, deps: McpDeps, input: unknown, opts: ServerOptions): CallToolResult {
	try {
		const result = runTool(name, deps, input, { knowledgeOnly: opts.knowledgeOnly }) as object;
		const bytes = Buffer.byteLength(JSON.stringify(result), "utf-8");
		if (bytes > (opts.responseMaxBytes ?? LIMITS.responseMaxBytes)) {
			throw new ToolError("response_too_large", "The result is larger than this server's response limit. Narrow the request.");
		}
		return asResult(result, false);
	} catch (error) {
		if (!(error instanceof ToolError)) opts.log?.(`tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		const failure: ToolFailure = error instanceof ToolError ? failureOf(error) : { error: { code: "internal", message: INTERNAL_MESSAGE } };
		return asResult(failure, true);
	}
}

export function createServer(deps: McpDeps, opts: ServerOptions): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS, maxToolInputElements: LIMITS.maxToolInputElements },
	);
	for (const name of TOOL_NAMES) {
		if (opts.knowledgeOnly && toolGroup(name) === "study") continue;
		const spec = CATALOG[name];
		if (spec === undefined) throw new Error(`tool ${name} has no catalog entry`);
		server.registerTool(
			name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.input,
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			},
			(args: unknown) => safeCall(name, deps, args, opts),
		);
	}
	return server;
}
