// tests/ext-trust-badge.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustBadgeView } from "../components/ext/trust-badge.tsx";

const evidence = [
	{ sourceRef: "lib_book", locator: "p. 3", quote: "Every bounded monotone sequence converges.", stance: "supports" as const, tier: "primary" as const },
];

describe("TrustBadgeView", () => {
	it("shows the level, evidence quote, tier and locator", () => {
		const html = renderToStaticMarkup(<TrustBadgeView level="sourced" evidence={evidence} busy={false} error={null} onVerify={() => {}} />);
		assert.match(html, /sourced/);
		assert.match(html, /Every bounded monotone sequence converges\./);
		assert.match(html, /primary/);
		assert.match(html, /p\. 3/);
	});
	it("offers verification and disables it while busy", () => {
		const idle = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={false} error={null} onVerify={() => {}} />);
		assert.match(idle, /Verify/);
		assert.ok(!/disabled/.test(idle));
		const busy = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={true} error={null} onVerify={() => {}} />);
		assert.match(busy, /disabled/);
	});
	it("shows an error message", () => {
		const html = renderToStaticMarkup(<TrustBadgeView level="unverified" evidence={[]} busy={false} error="no model configured" onVerify={() => {}} />);
		assert.match(html, /no model configured/);
	});
});
