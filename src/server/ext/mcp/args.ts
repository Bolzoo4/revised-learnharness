// src/server/ext/mcp/args.ts
/** Command line and environment of the server. The only flag is --knowledge-only; anything else is refused. */

import path from "node:path";

export interface McpArgs {
	dataRoot: string;
	knowledgeOnly: boolean;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>, defaultDataRoot: string): McpArgs {
	let knowledgeOnly = false;
	for (const arg of argv) {
		if (arg === "--knowledge-only") knowledgeOnly = true;
		else throw new Error(`unknown argument "${arg.slice(0, 40)}". The only option is --knowledge-only.`);
	}
	const fromEnv = env.LH_DATA_DIR;
	return { dataRoot: fromEnv !== undefined && fromEnv !== "" ? path.resolve(fromEnv) : defaultDataRoot, knowledgeOnly };
}
