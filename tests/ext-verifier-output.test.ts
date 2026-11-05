// tests/ext-verifier-output.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVerifierOutput } from "../src/core/ext/verifier-output.ts";

const good = {
	results: [
		{ nodeId: "n1", evidence: [{ sourceRef: "lib_a", locator: "p. 4", quote: "a verbatim passage here", stance: "supports" }] },
		{ nodeId: "n2", evidence: [] },
	],
	proposedSources: [{ kind: "url-prefix", locator: "https://mathworld.wolfram.com/", label: "MathWorld" }],
};

describe("parseVerifierOutput", () => {
	it("parses a fenced json block after prose", () => {
		const out = parseVerifierOutput("I checked.\n```json\n" + JSON.stringify(good) + "\n```\nDone.");
		assert.equal(out?.results.length, 2);
		assert.equal(out?.results[0]?.evidence[0]?.stance, "supports");
		assert.equal(out?.proposedSources[0]?.label, "MathWorld");
	});
	it("parses bare json and uses the LAST fenced block when several exist", () => {
		assert.equal(parseVerifierOutput(JSON.stringify(good))?.results.length, 2);
		const two = "```json\n{\"results\":[]}\n```\ntext\n```json\n" + JSON.stringify(good) + "\n```";
		assert.equal(parseVerifierOutput(two)?.results.length, 2);
	});
	it("drops invalid evidence items but keeps the rest", () => {
		const bad = { results: [{ nodeId: "n1", evidence: [
			{ sourceRef: "lib_a", locator: "p. 1", quote: "good quote text here ok", stance: "supports" },
			{ sourceRef: "lib_a", locator: "p. 1", quote: "x", stance: "maybe" },
			{ sourceRef: "", locator: "p. 1", quote: "y", stance: "supports" },
		] }] };
		assert.equal(parseVerifierOutput(JSON.stringify(bad))?.results[0]?.evidence.length, 1);
	});
	it("ignores unusable proposals", () => {
		const o = { results: [], proposedSources: [{ kind: "ftp", locator: "x", label: "y" }, { kind: "pdf", locator: "/a.pdf", label: "A" }] };
		assert.equal(parseVerifierOutput(JSON.stringify(o))?.proposedSources.length, 1);
	});
	it("returns null for no json, bad json, or a missing results array", () => {
		assert.equal(parseVerifierOutput("no json at all"), null);
		assert.equal(parseVerifierOutput("{ broken"), null);
		assert.equal(parseVerifierOutput('{"foo":1}'), null);
	});
});
