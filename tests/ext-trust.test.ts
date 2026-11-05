// tests/ext-trust.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deriveTrustMap,
	outcomeOf,
	parseVerificationEvent,
	trustTag,
	type Evidence,
	type VerificationEvent,
} from "../src/core/ext/trust.ts";

function ev(over: Partial<Evidence> = {}): Evidence {
	return {
		sourceRef: "https://a.org/x",
		sourceId: "lib_a",
		locator: "p. 1",
		quote: "a quote of sufficient length",
		snapshot: "h1",
		stance: "supports",
		tier: "primary",
		host: "a.org",
		...over,
	};
}
const secA = ev({ tier: "secondary", sourceId: "lib_a", host: "a.org" });
const secB = ev({ tier: "secondary", sourceId: "lib_b", host: "b.org" });

describe("outcomeOf (REQ-src-07..11)", () => {
	it("no evidence is unverified", () => assert.equal(outcomeOf([]), "unverified"));
	it("one supporting primary is sourced", () => assert.equal(outcomeOf([ev()]), "sourced"));
	it("one supporting secondary is not enough", () => assert.equal(outcomeOf([secA]), "unverified"));
	it("two independent supporting secondaries are sourced", () => assert.equal(outcomeOf([secA, secB]), "sourced"));
	it("two secondaries on the same host without author labels are not independent", () => {
		assert.equal(outcomeOf([secA, { ...secB, host: "a.org" }]), "unverified");
	});
	it("same host but different author labels are independent", () => {
		assert.equal(outcomeOf([{ ...secA, author: "Rudin" }, { ...secB, host: "a.org", author: "Tao" }]), "sourced");
	});
	it("same host with only one author label is not provably independent", () => {
		assert.equal(outcomeOf([{ ...secA, author: "Rudin" }, { ...secB, host: "a.org" }]), "unverified");
	});
	it("the same library entry twice is never independent", () => {
		assert.equal(outcomeOf([secA, { ...secA, host: "other.org" }]), "unverified");
	});
	it("unvetted evidence never qualifies, for or against", () => {
		const unv = ev({ tier: "unvetted", sourceId: null });
		assert.equal(outcomeOf([unv]), "unverified");
		assert.equal(outcomeOf([ev(), { ...unv, stance: "contradicts" }]), "sourced");
	});
	it("a supporting primary with a contradicting primary is contested", () => {
		assert.equal(outcomeOf([ev(), ev({ stance: "contradicts", sourceId: "lib_c", host: "c.org" })]), "contested");
	});
	it("a contradicting secondary does not block a supporting primary", () => {
		assert.equal(outcomeOf([ev(), { ...secB, stance: "contradicts" }]), "sourced");
	});
	it("a supporting secondary against a contradicting secondary is contested", () => {
		assert.equal(outcomeOf([secA, { ...secB, stance: "contradicts" }]), "contested");
	});
	it("only contradicting qualified evidence is refuted", () => {
		assert.equal(outcomeOf([{ ...secB, stance: "contradicts" }]), "refuted");
	});
	it("is order independent (deterministic)", () => {
		const items = [ev({ stance: "contradicts", sourceId: "lib_c", host: "c.org" }), secA, secB, ev()];
		const expected = outcomeOf(items);
		for (let i = 0; i < items.length; i++) assert.equal(outcomeOf([...items.slice(i), ...items.slice(0, i)]), expected);
	});
});

function checkedEvent(nodeId: string, outcome: "unverified" | "sourced" | "contested" | "refuted", at: string): VerificationEvent {
	return { type: "checked", nodeId, outcome, evidence: outcome === "sourced" ? [ev()] : [], discarded: [], checker: "m:1", at };
}

describe("deriveTrustMap (REQ-ver-01, REQ-src-12)", () => {
	it("defaults are absent (callers read unverified) and the latest checked event wins", () => {
		const map = deriveTrustMap([checkedEvent("n1", "sourced", "t1"), checkedEvent("n1", "contested", "t2")]);
		assert.equal(map.get("n1")?.level, "contested");
		assert.equal(map.get("n2"), undefined);
	});
	it("a failed check never changes the level", () => {
		const map = deriveTrustMap([
			checkedEvent("n1", "sourced", "t1"),
			{ type: "check_failed", nodeId: "n1", reason: "boom", at: "t2" },
		]);
		assert.equal(map.get("n1")?.level, "sourced");
	});
	it("a failed check alone leaves the node without a level", () => {
		assert.equal(deriveTrustMap([{ type: "check_failed", nodeId: "n1", reason: "x", at: "t" }]).get("n1"), undefined);
	});
	it("exposes the evidence of the latest checked event", () => {
		assert.equal(deriveTrustMap([checkedEvent("n1", "sourced", "t")]).get("n1")?.evidence.length, 1);
	});
});

describe("parseVerificationEvent", () => {
	it("round-trips a valid checked event and a check_failed event", () => {
		const e = checkedEvent("n1", "sourced", "2026-11-04T10:00:00.000Z");
		assert.deepEqual(parseVerificationEvent(JSON.parse(JSON.stringify(e))), e);
		const f: VerificationEvent = { type: "check_failed", nodeId: "n1", reason: "x", at: "t" };
		assert.deepEqual(parseVerificationEvent(f), f);
	});
	it("rejects bad outcome, bad evidence and unknown types", () => {
		assert.equal(parseVerificationEvent({ ...checkedEvent("n1", "sourced", "t"), outcome: "maybe" }), null);
		assert.equal(parseVerificationEvent({ ...checkedEvent("n1", "sourced", "t"), evidence: [{ quote: "x" }] }), null);
		assert.equal(parseVerificationEvent({ type: "other", nodeId: "n1", at: "t" }), null);
		assert.equal(parseVerificationEvent({ ...checkedEvent("", "sourced", "t") }), null);
	});
});

describe("trustTag", () => {
	it("is self-explanatory for each level", () => {
		assert.match(trustTag("unverified"), /not checked/);
		assert.match(trustTag("sourced"), /sourced/);
		assert.match(trustTag("contested"), /disagree/);
		assert.match(trustTag("refuted"), /contradict/);
	});
});
