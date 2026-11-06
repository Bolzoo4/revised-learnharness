// tests/helpers/mcp-run.ts
import assert from "node:assert/strict";
import { ToolError, type ToolErrorCode } from "../../src/core/ext/mcp/errors.ts";
import { runTool } from "../../src/core/ext/mcp/tools.ts";
import type { Fixture } from "./mcp-fixture.ts";

export type Json = any;

export function call(f: Fixture, name: string, input: unknown = {}, knowledgeOnly = false): Json {
	return runTool(name, f.deps, input, { knowledgeOnly });
}

export function errorCode(f: Fixture, name: string, input: unknown = {}, knowledgeOnly = false): ToolErrorCode | "none" | "other" {
	try {
		runTool(name, f.deps, input, { knowledgeOnly });
		return "none";
	} catch (e) {
		return e instanceof ToolError ? e.code : "other";
	}
}

export function expectError(f: Fixture, name: string, input: unknown, code: ToolErrorCode, knowledgeOnly = false): void {
	assert.equal(errorCode(f, name, input, knowledgeOnly), code, `${name}(${JSON.stringify(input)})`);
}
