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
import { LECTURE_TOTAL_BYTES_MAX } from "../src/store/ext/readonly.ts";

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

	it("states every bound of the bounds table at the value the code enforces", () => {
		const table = section.slice(section.indexOf("### Bounds"), section.indexOf("### Knowledge group"));
		const row = (label: string): string => {
			const line = table.split("\n").find((l) => l.startsWith(`| ${label} |`));
			assert.ok(line, `bounds row "${label}" is missing`);
			return line!;
		};
		assert.ok(row("default / maximum `limit`").includes(`${LIMITS.listDefault} / ${LIMITS.listMax}`));
		assert.ok(row("default / maximum `limit`").includes(`debriefs ${LIMITS.debriefsDefault} / ${LIMITS.debriefsMax}`));
		assert.ok(row("query").includes(`${LIMITS.queryMaxChars} characters, ${LIMITS.queryMaxTokens} words`));
		assert.ok(row("id").includes(`${LIMITS.idMaxChars} characters`));
		assert.ok(row("statement / explanation / quote").includes(`${LIMITS.statementChars} / ${LIMITS.explanationChars} / ${LIMITS.quoteChars} characters`));
		assert.ok(row("neighbourhood").includes(`${LIMITS.neighbourNodesMax} nodes, ${LIMITS.neighbourEdgesMax} edges`));
		assert.ok(row("lectures / documents").includes(`${LIMITS.lecturesMax} each`));
		assert.ok(row("response").includes(`${LIMITS.responseMaxBytes / 1024} KiB`));
		assert.ok(row("future day for `get_daily_plan`").includes(`${LIMITS.futureDaysMax} days`));
		assert.ok(row("lecture files read by one `list_lectures`").includes(`${LECTURE_TOTAL_BYTES_MAX / 1024 / 1024} MiB`));
		assert.ok(row("lecture files parsed by one `get_node` (index build)").includes(`${LECTURE_TOTAL_BYTES_MAX / 1024 / 1024} MiB`));
		assert.ok(row("each array of a lecture outline (slides, exercises, cited nodes)").includes(`${LIMITS.lectureSectionBudgetBytes / 1024} KiB`));
		assert.ok(section.includes(`${LIMITS.requestMaxBytes / 1024} KiB ends the session`), "the request ceiling and its effect");
		assert.ok(!/npm run mcp|scripts\/mcp-ext/.test(doc), "the launch command is the script itself, with no npm script");
	});

	it("states the read-only facts a consumer relies on", () => {
		for (const phrase of ["readOnlyHint: true", "never writes", "no socket", "format.json", "--knowledge-only", "LH_DATA_DIR"]) assert.ok(section.includes(phrase), phrase);
	});
});
