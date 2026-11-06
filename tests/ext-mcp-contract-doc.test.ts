// tests/ext-mcp-contract-doc.test.ts
/**
 * REQ-mcp-12: the language-neutral contract in docs/ext/CONTRACTS.md names every
 * tool, every input field, every error code and the headline bounds of the code.
 * A tool or field added without documentation fails here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ToolErrorCode } from "../src/core/ext/mcp/errors.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { toolFields, TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";

const doc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "ext", "CONTRACTS.md"), "utf-8");
const section = doc.slice(doc.indexOf("## MCP server (read-only, stdio)"));

const ERROR_CODES: ToolErrorCode[] = ["invalid_input", "not_found", "disabled", "data_newer_than_build", "data_too_large", "data_inconsistent", "response_too_large", "internal"];

describe("the MCP contract document (REQ-mcp-12)", () => {
	it("has the MCP section", () => {
		assert.ok(section.startsWith("## MCP server"), "section missing");
	});

	it("describes every tool, with every one of its input fields, in the tool's own paragraph", () => {
		for (const name of TOOL_NAMES) {
			const start = section.indexOf(`\`${name}\` input:`);
			assert.ok(start >= 0, `${name} is not documented`);
			const end = section.indexOf("\n\n", start);
			const paragraph = section.slice(start, end < 0 ? undefined : end);
			for (const field of toolFields(name)) assert.ok(paragraph.includes(`\`${field}\``), `${name}: input field ${field} is not documented`);
			assert.ok(paragraph.includes("Output:"), `${name}: output is not documented`);
		}
	});

	it("lists every error code", () => {
		for (const code of ERROR_CODES) assert.ok(section.includes(`\`${code}\``), code);
	});

	it("states the bounds the code enforces", () => {
		assert.ok(section.includes(`${LIMITS.responseMaxBytes / 1024} KiB`));
		assert.ok(section.includes(`${LIMITS.requestMaxBytes / 1024} KiB`));
		assert.ok(section.includes(`${LIMITS.ledgerMaxBytes / 1024 / 1024} MiB`));
		assert.ok(section.includes(`${LIMITS.queryMaxChars} characters, ${LIMITS.queryMaxTokens} words`));
		assert.ok(section.includes(`${LIMITS.neighbourNodesMax} nodes, ${LIMITS.neighbourEdgesMax} edges`));
		assert.ok(section.includes(`${LIMITS.futureDaysMax} days`));
		assert.ok(section.includes(`${LIMITS.listDefault} / ${LIMITS.listMax}`));
		if (TOOL_NAMES.includes("get_recent_debriefs")) {
			assert.ok(section.includes(`${LIMITS.listBudgetBytes / 1024} KiB`));
			assert.ok(section.includes(`${LIMITS.factsBytes / 1024} KiB`));
		}
	});

	it("states the read-only facts a consumer relies on", () => {
		for (const phrase of ["readOnlyHint: true", "never writes", "no socket", "format.json", "--knowledge-only", "LH_DATA_DIR"]) assert.ok(section.includes(phrase), phrase);
	});
});
