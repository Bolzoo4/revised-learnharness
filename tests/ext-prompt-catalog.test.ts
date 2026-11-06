/**
 * The editable extension prompts: the catalog (pure) and the default text of
 * every entry. A default is read from source, so this suite needs no data dir.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXT_PROMPT_CATALOG, EXT_PROMPT_IDS, EXT_PROMPT_MAX_TEXT_CHARS, extPromptEntry, isExtPromptId } from "../src/core/ext/prompt-catalog.ts";
import { EXT_PROMPT_DEFAULTS, extPromptDefault } from "../src/agent/ext/prompt-defaults.ts";

describe("extension prompt catalog", () => {
	it("has no duplicate ids and the list and the entries agree", () => {
		const ids = EXT_PROMPT_CATALOG.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length, "duplicate id");
		assert.deepEqual(ids, [...EXT_PROMPT_IDS]);
	});

	it("gives every entry a label, a one-line description and a warning", () => {
		for (const entry of EXT_PROMPT_CATALOG) {
			assert.ok(entry.label.trim() !== "", `${entry.id}: label`);
			assert.ok(entry.description.trim() !== "" && !entry.description.includes("\n"), `${entry.id}: description`);
			assert.ok(entry.warning.trim() !== "", `${entry.id}: warning`);
		}
	});

	it("resolves a default text for every id, non-empty and readable from source", () => {
		for (const id of EXT_PROMPT_IDS) {
			assert.ok(typeof EXT_PROMPT_DEFAULTS[id] === "function", `${id}: no default registered`);
			assert.ok(extPromptDefault(id).trim() !== "", `${id}: default is empty`);
		}
	});

	it("keeps the focus variants to their static body (no per-run data in a default)", () => {
		assert.ok(!extPromptDefault("review-card").includes("Card answer:"));
		assert.ok(!extPromptDefault("review-node").includes("Node id:"));
		assert.ok(!extPromptDefault("office-hours").includes("## The exercise in focus"));
	});

	it("accepts only catalog ids", () => {
		for (const id of EXT_PROMPT_IDS) assert.equal(isExtPromptId(id), true, id);
		for (const bad of ["", "verifier.md", "../verifier", "ext/verifier", "__proto__", "constructor", "toString", "VERIFIER", " verifier", "review-daily\n"]) {
			assert.equal(isExtPromptId(bad), false, JSON.stringify(bad));
		}
		assert.equal(isExtPromptId(undefined), false);
		assert.equal(isExtPromptId(7), false);
		assert.equal(extPromptEntry("nope"), undefined);
	});

	it("bounds an override at 20000 characters", () => {
		assert.equal(EXT_PROMPT_MAX_TEXT_CHARS, 20_000);
	});
});
