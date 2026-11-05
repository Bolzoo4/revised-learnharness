// tests/ext-explanation-check.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkExplanation,
	extractNodeLinks,
	linkifyNodeLinks,
	MAX_SENTENCE_WORDS,
	mentionedBy,
	NODE_HREF_PREFIX,
} from "../src/core/ext/explanation-check.ts";

const ids = new Set(["n_a", "n_b"]);
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("extractNodeLinks", () => {
	it("returns each linked id once, in order", () => {
		assert.deepEqual(extractNodeLinks("See [[n_b]] and [[n_a]], then [[n_b]] again."), ["n_b", "n_a"]);
	});
	it("ignores single brackets and links with spaces", () => {
		assert.deepEqual(extractNodeLinks("[n_a] and [[not a link]]"), []);
	});
});

describe("checkExplanation (REQ-node-07, REQ-node-08)", () => {
	it("passes a clean text", () => {
		assert.deepEqual(checkExplanation("A implies [[n_a]]. It is short.", ids), { errors: [], warnings: [] });
	});

	it("rejects an unresolved link as an error", () => {
		const result = checkExplanation("Needs [[n_missing]].", ids);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0] ?? "", /n_missing/);
	});

	it("rejects an empty text and placeholders", () => {
		assert.equal(checkExplanation("   ", ids).errors.length, 1);
		for (const bad of ["TODO write this.", "This is TBD.", "Lorem ipsum dolor.", "Step [...] here.", "[insert example] now."]) {
			assert.equal(checkExplanation(bad, ids).errors.length, 1, bad);
		}
	});

	it("does not flag the ordinary word todo", () => {
		assert.deepEqual(checkExplanation("Es todo lo que hace falta.", ids).errors, []);
	});

	it("warns, never errors, on a sentence longer than the limit", () => {
		const long = `${words(MAX_SENTENCE_WORDS + 5)}.`;
		const result = checkExplanation(long, ids);
		assert.deepEqual(result.errors, []);
		assert.equal(result.warnings.length, 1);
		assert.equal(checkExplanation(`${words(MAX_SENTENCE_WORDS)}.`, ids).warnings.length, 0);
	});

	it("does not count formulas, code, headings or link ids as words", () => {
		const text = `## Heading with many many many many many many many many many many many many many many many many many many many many many many many many many many words\n\nWe get $${words(40)}$ and [[n_a]].\n\n\`\`\`\n${words(60)}.\n\`\`\``;
		assert.deepEqual(checkExplanation(text, ids).warnings, []);
	});

	it("rejects a nonsense limit", () => {
		assert.throws(() => checkExplanation("x.", ids, 0), RangeError);
	});
});

describe("mentionedBy (REQ-node-15: derived, never stored)", () => {
	it("lists the nodes whose current explanation links to the target, sorted, excluding itself", () => {
		const bodies = new Map([
			["n_c", "Uses [[n_a]]."],
			["n_b", "Uses [[n_a]] and [[n_c]]."],
			["n_a", "Mentions itself [[n_a]]."],
			["n_d", "No link."],
		]);
		assert.deepEqual(mentionedBy("n_a", bodies), ["n_b", "n_c"]);
		assert.deepEqual(mentionedBy("n_c", bodies), ["n_b"]);
		assert.deepEqual(mentionedBy("n_zzz", bodies), []);
	});
});

describe("linkifyNodeLinks", () => {
	it("turns a known link into a markdown link with the node name and hides unknown ones", () => {
		const out = linkifyNodeLinks("See [[n_a]] and [[n_x]].", { n_a: "Alpha [1]" });
		assert.equal(out, `See [Alpha 1](${NODE_HREF_PREFIX}n_a) and (unknown node).`);
	});
	it("does not trust inherited object keys", () => {
		assert.equal(linkifyNodeLinks("[[constructor]]", {}), "(unknown node)");
	});
});
