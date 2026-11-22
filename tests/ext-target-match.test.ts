// tests/ext-target-match.test.ts
/**
 * The cheap first pass of goal targets (REQ-graph-agent-27): a target statement that equals an existing node's
 * name, alias or statement after normalisation is that node, and the model judgement is spared.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchExistingNode, normalizeText } from "../src/core/ext/target-match.ts";

const node = (id: string, name: string, statement: string, aliases: string[] = []) => ({ id, name, statement, aliases });

describe("normalizeText", () => {
	it("lowercases, strips accents and punctuation, and collapses spaces", () => {
		assert.equal(normalizeText("  Caffè,   Perché!  "), "caffe perche");
		assert.equal(normalizeText("Sia f_n → f (q.c.d.)"), "sia f n f q c d");
	});

	it("keeps letters of any script and digits", () => {
		assert.equal(normalizeText("Teorema 3.1.2 — Ω"), "teorema 3 1 2 ω");
	});
});

describe("matchExistingNode", () => {
	const nodes = [
		node("n_a", "Convergenza dominata", "Se |f_n| <= g e f_n -> f q.o., allora gli integrali convergono."),
		node("n_b", "Chiusura", "Una σ-algebra è chiusa per unioni numerabili.", ["sigma algebra closure"]),
	];

	it("an exact normalised equality with the statement is the same node", () => {
		assert.equal(matchExistingNode("se |f_n| <= g e f_n -> f q.o. allora gli integrali convergono", nodes), "n_a");
	});

	it("the same claim with accents and punctuation changed is the same node", () => {
		assert.equal(matchExistingNode("UNA  σ-ALGEBRA e chiusa per unioni numerabili!", nodes), "n_b");
	});

	it("an alias that equals the target is the same node", () => {
		assert.equal(matchExistingNode("Sigma algebra closure!", nodes), "n_b");
	});

	it("the node's name is matched too", () => {
		assert.equal(matchExistingNode("convergenza dominata", nodes), "n_a");
	});

	it("a merely similar statement (shared words, another claim) is not a match: the judgement decides", () => {
		assert.equal(matchExistingNode("Una σ-algebra è chiusa per intersezioni numerabili", nodes), null);
		assert.equal(matchExistingNode("gli integrali convergono", nodes), null);
	});

	it("with no nodes there is no match", () => {
		assert.equal(matchExistingNode("anything", []), null);
	});
});
