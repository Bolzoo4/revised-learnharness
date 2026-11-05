import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { panelTrustOf } from "../src/core/ext/panel-trust.ts";
import type { Evidence } from "../src/core/ext/trust.ts";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
	sourceRef: "https://example.org/x",
	sourceId: "s1",
	locator: "p. 3",
	quote: "A quote.",
	snapshot: "abc",
	stance: "supports",
	tier: "primary",
	host: "example.org",
	...over,
});

describe("panelTrustOf (REQ-node-12)", () => {
	it("maps level and evidence rows", () => {
		assert.deepEqual(panelTrustOf({ nodeId: "n", level: "sourced", at: "t", evidence: [ev()] }), {
			level: "sourced",
			evidence: [{ sourceId: "s1", locator: "p. 3", quote: "A quote.", stance: "supports", tier: "primary", snapshotHash: "abc" }],
		});
	});

	it("an unvetted item has no library id: the cited reference stands in", () => {
		const t = panelTrustOf({ nodeId: "n", level: "contested", at: "t", evidence: [ev({ sourceId: null, tier: "unvetted", stance: "contradicts" })] });
		assert.equal(t.evidence[0]?.sourceId, "https://example.org/x");
		assert.equal(t.evidence[0]?.tier, "unvetted");
		assert.equal(t.evidence[0]?.stance, "contradicts");
	});

	it("no view means unverified with no evidence", () => {
		assert.deepEqual(panelTrustOf(undefined), { level: "unverified", evidence: [] });
	});
});
