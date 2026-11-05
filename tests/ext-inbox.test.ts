// tests/ext-inbox.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deriveInbox,
	ingestedLocators,
	normalizeLocator,
	parseInboxEvent,
	sourceFilePath,
	triage,
	type InboxEvent,
} from "../src/core/ext/inbox.ts";

const proposed = (locator: string, over: Partial<Extract<InboxEvent, { type: "proposed" }>> = {}): InboxEvent => ({
	type: "proposed",
	locator,
	title: "T",
	gapId: "no-premises:n1",
	foundBy: "cycle",
	cycleId: "cyc_1",
	snapshot: "a".repeat(64),
	at: "2026-11-04T10:00:00.000Z",
	...over,
});

describe("inbox events", () => {
	it("parses the three event types and rejects bad shapes", () => {
		assert.deepEqual(parseInboxEvent(proposed("https://x.org/a")), proposed("https://x.org/a"));
		assert.deepEqual(parseInboxEvent({ type: "decided", locator: "u", decision: "rejected", at: "t" }), { type: "decided", locator: "u", decision: "rejected", at: "t" });
		assert.equal(parseInboxEvent({ type: "decided", locator: "u", decision: "maybe", at: "t" }), null);
		assert.equal(parseInboxEvent({ type: "ingested", locator: "u", nodesAdded: -1, at: "t" }), null);
		assert.equal(parseInboxEvent({ ...proposed("u"), foundBy: "user" }), null);
		assert.equal(parseInboxEvent({ ...proposed("u"), snapshot: "" }), null);
	});

	it("derives status per locator: pending, then the last decision", () => {
		const items = deriveInbox([
			proposed("a"),
			proposed("b"),
			proposed("a", { title: "ignored duplicate" }),
			{ type: "decided", locator: "a", decision: "approved", at: "t1" },
			{ type: "decided", locator: "a", decision: "activated", at: "t2" },
			{ type: "decided", locator: "ghost", decision: "approved", at: "t3" },
		]);
		assert.deepEqual(items.map((i) => [i.locator, i.status, i.title]), [["a", "activated", "T"], ["b", "pending", "T"]]);
		assert.equal(items[0]!.decidedAt, "t2");
	});

	it("tracks ingested locators", () => {
		assert.deepEqual([...ingestedLocators([{ type: "ingested", locator: "a", nodesAdded: 2, at: "t" }, proposed("b")])], ["a"]);
	});
});

describe("locators", () => {
	it("normalizes: host case, fragment, trailing slash", () => {
		assert.equal(normalizeLocator("HTTPS://Example.ORG/Paper/#sec2"), "https://example.org/Paper");
		assert.equal(normalizeLocator("https://example.org/"), "https://example.org");
		assert.equal(normalizeLocator("  /papers/a.pdf "), "/papers/a.pdf");
	});

	it("derives a stable notes path from a locator", () => {
		assert.equal(sourceFilePath("https://www.arxiv.org/abs/1706.03762"), "research/arxiv.org/abs-1706.03762.md");
		assert.equal(sourceFilePath("https://x.org"), "research/x.org/index.md");
		assert.equal(sourceFilePath("https://x.org/a?b=1"), sourceFilePath("https://x.org/a?b=1"));
		assert.ok(sourceFilePath("not a url at all").startsWith("research/source/"));
	});
});

describe("triage (REQ-rs-07, REQ-rs-08)", () => {
	it("an active source is ingested, any other goes to the inbox", () => {
		assert.equal(triage("u", true, []), "ingest");
		assert.equal(triage("u", false, []), "inbox");
	});

	it("a rejected source is never proposed again, even if it later becomes active", () => {
		const events: InboxEvent[] = [proposed("u"), { type: "decided", locator: "u", decision: "rejected", at: "t" }];
		assert.equal(triage("u", false, events), "skip-rejected");
		assert.equal(triage("u", true, events), "skip-rejected");
	});

	it("a pending or already ingested source is not handled twice", () => {
		assert.equal(triage("u", false, [proposed("u")]), "skip-seen");
		assert.equal(triage("v", true, [{ type: "ingested", locator: "v", nodesAdded: 1, at: "t" }]), "skip-seen");
	});

	it("any source already in the inbox is left to the user's decision", () => {
		const events: InboxEvent[] = [proposed("u"), { type: "decided", locator: "u", decision: "approved", at: "t" }];
		assert.equal(triage("u", false, events), "skip-seen");
	});
});

describe("hardening: edge cases", () => {
	it("a trailing slash inside the query is kept; only the path loses it", () => {
		assert.equal(normalizeLocator("https://x.org/a/?q=b/"), "https://x.org/a?q=b/");
		assert.equal(normalizeLocator("https://x.org/?q=1"), "https://x.org?q=1");
		assert.equal(normalizeLocator(""), "");
	});

	it("derive, ingested and triage see equivalent locators as one", () => {
		const events: InboxEvent[] = [proposed("https://X.org/a/"), { type: "decided", locator: "https://x.org/a#top", decision: "rejected", at: "t" }];
		assert.equal(deriveInbox(events).length, 1);
		assert.equal(deriveInbox(events)[0]!.status, "rejected");
		assert.equal(triage("https://x.org/a", true, events), "skip-rejected");
		assert.equal(triage("https://x.org/a", true, [{ type: "ingested", locator: "https://X.org/a/", nodesAdded: 1, at: "t" }]), "skip-seen");
	});

	it("a decision that precedes its proposal is ignored; the last of several decisions wins", () => {
		const items = deriveInbox([{ type: "decided", locator: "a", decision: "rejected", at: "t0" }, proposed("a")]);
		assert.equal(items[0]!.status, "pending");
		assert.equal(deriveInbox([]).length, 0);
	});

	it("parse rejects empty locators, fractional or NaN counts and missing timestamps", () => {
		assert.equal(parseInboxEvent({ type: "ingested", locator: "", nodesAdded: 1, at: "t" }), null);
		assert.equal(parseInboxEvent({ type: "ingested", locator: "u", nodesAdded: Number.NaN, at: "t" }), null);
		assert.equal(parseInboxEvent({ type: "ingested", locator: "u", nodesAdded: 1.5, at: "t" }), null);
		assert.equal(parseInboxEvent({ type: "decided", locator: "u", decision: "approved" }), null);
		assert.equal(parseInboxEvent(null), null);
		assert.equal(parseInboxEvent("x"), null);
	});

	it("source paths: equivalent locators share a path, query/long paths cannot collide, hosts are safe", () => {
		assert.equal(sourceFilePath("https://x.org/a/#f"), sourceFilePath("https://X.org/a"));
		assert.notEqual(sourceFilePath("https://x.org/a?b=1"), sourceFilePath("https://x.org/a?b=2"));
		assert.notEqual(sourceFilePath(`https://x.org/${"a".repeat(100)}1`), sourceFilePath(`https://x.org/${"a".repeat(100)}2`));
		assert.match(sourceFilePath("http://[::1]:3000/p"), /^research\/[A-Za-z0-9._-]+\/p\.md$/);
		assert.match(sourceFilePath("../../etc/passwd"), /^research\/source\/[A-Za-z0-9._-]+\.md$/);
	});
});
