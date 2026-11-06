// tests/ext-mcp-dispatch.test.ts
/** runTool is the core's own gatekeeper, independent of the SDK's schema validation (defence in depth, REQ-mcp-02, -10). */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, makeFixture, N, seedStandard } from "./helpers/mcp-fixture.ts";
import { call, errorCode, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("runTool", () => {
	it("refuses an unknown argument on every tool, even when the schema layer would let it through", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const tool of TOOL_NAMES) {
			for (const key of ["delete", "write", "mark", "set", "__proto__x", "id2"]) {
				const input = { ...(tool === "get_node" || tool === "get_neighbors" || tool === "get_goal" ? { id: N.a } : {}), [key]: true };
				assert.equal(errorCode(f, tool, input), "invalid_input", `${tool} accepted "${key}"`);
			}
		}
	});

	it("refuses an unknown tool, including names inherited from Object, and non-object arguments (an absent or null argument object means no arguments)", () => {
		const f = makeFixture();
		for (const name of ["", "constructor", "__proto__", "toString", "hasOwnProperty", "set_goal", "GET_NODE", "get_node ", "get_node\n"]) {
			expectError(f, name, {}, "not_found");
		}
		for (const input of [null, undefined, 3, "x", true, [], [1]]) {
			const code = errorCode(f, "research_status", input);
			assert.ok(code === "invalid_input" || ((input === undefined || input === null) && code === "none"), `research_status(${JSON.stringify(input)}) gave ${code}`);
		}
	});

	it("checks the format stamp before anything else, even for an unknown argument or a disabled tool", () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("graph", 99);
		expectError(f, "get_node", { id: N.a, delete: true }, "data_newer_than_build");
		expectError(f, "list_goals", {}, "data_newer_than_build", true);
	});

	it("a stamp at the supported version is accepted; a corrupt or non-numeric stamp does not refuse", () => {
		const f = makeFixture();
		seedStandard(f);
		f.writeStamp("ext", 1);
		assert.equal(errorCode(f, "research_status"), "none");
		fs.writeFileSync(`${f.extDir}/format.json`, "{not json");
		assert.equal(errorCode(f, "research_status"), "none");
		fs.writeFileSync(`${f.extDir}/format.json`, JSON.stringify({ version: "99" }));
		assert.equal(errorCode(f, "research_status"), "none");
		assert.equal(call(f, "get_node", { id: N.a }).id, N.a);
	});

	it("a writer caught mid-append (a torn last line) never breaks a read; the completed line shows up on the next call", () => {
		const f = makeFixture();
		seedStandard(f);
		const file = `${f.extDir}/review.jsonl`;
		const base = fs.readFileSync(file, "utf-8");
		const line = JSON.stringify({ type: "review", nodeId: N.lone, channel: "fixed", rating: 3, durationSec: 12, at: "2026-11-04T09:00:00.000Z" });
		for (let cut = 1; cut < line.length; cut += 11) {
			fs.writeFileSync(file, base + line.slice(0, cut)); // the writer is in the middle of its append
			assert.equal(call(f, "get_node", { id: N.lone }).review, null, `a torn line (${cut} bytes) is not a review`);
			assert.equal(errorCode(f, "get_daily_plan"), "none");
		}
		fs.writeFileSync(file, base + line + "\n"); // the append completes
		assert.notEqual(call(f, "get_node", { id: N.lone }).review, null);
	});
});
