// tests/ext-explanations.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveExplanations, parseExplanationEvent, type ExplanationEvent } from "../src/core/ext/explanations.ts";

type VersionEvent = Extract<ExplanationEvent, { type: "version" }>;
const AT = "2026-11-04T10:00:00.000Z";

function v(over: Partial<VersionEvent> = {}): ExplanationEvent {
	return {
		type: "version",
		nodeId: "n_a",
		version: 1,
		body: "A holds.",
		author: "agent",
		sourceRefs: [],
		styleVersion: "s1",
		fingerprint: "",
		noSource: true,
		proposed: false,
		at: AT,
		...over,
	};
}
const decision = (version: number, d: "approved" | "rejected", nodeId = "n_a"): ExplanationEvent => ({
	type: "decision",
	nodeId,
	version,
	decision: d,
	at: AT,
});

describe("parseExplanationEvent", () => {
	it("accepts a valid version and a valid decision", () => {
		assert.deepEqual(parseExplanationEvent(v()), v());
		assert.deepEqual(parseExplanationEvent(decision(2, "approved")), decision(2, "approved"));
	});

	it("rejects malformed events", () => {
		for (const bad of [
			null,
			"x",
			{ type: "other" },
			v({ body: "   " }),
			v({ version: 0 }),
			v({ version: 1.5 }),
			v({ nodeId: "" }),
			v({ author: "user", proposed: true }),
			{ ...v(), sourceRefs: "h" },
			{ ...v(), noSource: "yes" },
			{ ...decision(1, "approved"), decision: "maybe" },
		]) {
			assert.equal(parseExplanationEvent(bad), null, JSON.stringify(bad));
		}
	});

	it("accepts the empty fingerprint of a node with no concluding chain", () => {
		assert.notEqual(parseExplanationEvent(v({ fingerprint: "" })), null);
	});
});

describe("deriveExplanations", () => {
	it("the latest accepted version is the current explanation", () => {
		const map = deriveExplanations([v({ version: 1, body: "one" }), v({ version: 2, body: "two" })]);
		assert.equal(map.get("n_a")?.current?.body, "two");
		assert.equal(map.get("n_a")?.latestVersion, 2);
		assert.equal(map.get("n_a")?.proposal, null);
	});

	it("a proposed version is not current until approved (REQ-node-02)", () => {
		const events = [v({ version: 1, author: "user", body: "mine" }), v({ version: 2, proposed: true, body: "agent" })];
		const pending = deriveExplanations(events).get("n_a");
		assert.equal(pending?.current?.body, "mine");
		assert.equal(pending?.proposal?.body, "agent");
		const approved = deriveExplanations([...events, decision(2, "approved")]).get("n_a");
		assert.equal(approved?.current?.body, "agent");
		assert.equal(approved?.proposal, null);
	});

	it("a rejected proposal disappears and the user version stays current", () => {
		const events = [v({ version: 1, author: "user", body: "mine" }), v({ version: 2, proposed: true }), decision(2, "rejected")];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "mine");
		assert.equal(e?.proposal, null);
		assert.equal(e?.latestVersion, 2);
	});

	it("a newer user version supersedes an older pending proposal", () => {
		const events = [v({ version: 1, proposed: true }), v({ version: 2, author: "user", body: "newer" })];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "newer");
		assert.equal(e?.proposal, null);
	});

	it("the first line for a version number wins; decisions for unknown versions or nodes are ignored", () => {
		const events = [v({ version: 1, body: "first" }), v({ version: 1, body: "dup" }), decision(9, "approved"), decision(1, "approved", "n_zzz")];
		const e = deriveExplanations(events).get("n_a");
		assert.equal(e?.current?.body, "first");
		assert.equal(deriveExplanations(events).has("n_zzz"), false);
	});

	it("keeps nodes separate", () => {
		const map = deriveExplanations([v({ nodeId: "n_a" }), v({ nodeId: "n_b", body: "B" })]);
		assert.equal(map.size, 2);
		assert.equal(map.get("n_b")?.current?.body, "B");
	});
});
