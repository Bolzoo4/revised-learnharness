// tests/ext-inbox-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideInboxItem, InboxError } from "../src/core/ext/inbox-service.ts";
import { deriveInbox, ingestedLocators, type InboxEvent } from "../src/core/ext/inbox.ts";
import type { LibraryEntryInput } from "../src/core/ext/research-ports.ts";
import { memLog } from "./helpers/research-fakes.ts";

const proposed: InboxEvent = { type: "proposed", locator: "https://a.org/x", title: "Paper X", gapId: "g", foundBy: "cycle", cycleId: "c", snapshot: "h1", at: "t" };

function setup(snapshotText: string | null = "the page text") {
	const inbox = memLog<InboxEvent>([proposed]);
	const activated: LibraryEntryInput[] = [];
	const ingested: string[] = [];
	return {
		inbox,
		activated,
		ingested,
		deps: {
			inbox,
			snapshots: { get: (h: string) => (h === "h1" ? snapshotText : null) },
			library: { activate: (e: LibraryEntryInput) => void activated.push(e) },
			ingest: async (s: { locator: string; text: string }) => (ingested.push(s.text), 4),
			now: () => new Date("2026-11-04T12:00:00.000Z"),
		},
	};
}

describe("decideInboxItem", () => {
	it("reject: records the decision and ingests nothing (REQ-rs-09)", async () => {
		const s = setup();
		assert.deepEqual(await decideInboxItem(s.deps, "https://a.org/x", "rejected"), { decision: "rejected", nodesAdded: 0 });
		assert.equal(deriveInbox(s.inbox.events)[0]!.status, "rejected");
		assert.deepEqual(s.ingested, []);
	});

	it("approve: ingests the stored snapshot once, without touching the library", async () => {
		const s = setup();
		assert.deepEqual(await decideInboxItem(s.deps, "https://a.org/x", "approved"), { decision: "approved", nodesAdded: 4 });
		assert.deepEqual(s.ingested, ["the page text"]);
		assert.deepEqual(s.activated, []);
		assert.equal(ingestedLocators(s.inbox.events).has("https://a.org/x"), true);
	});

	it("activate: adds an active library entry with the chosen tier, then ingests", async () => {
		const s = setup();
		await decideInboxItem(s.deps, "https://a.org/x", "activated", "primary");
		assert.deepEqual(s.activated, [{ locator: "https://a.org/x", kind: "url-prefix", label: "Paper X", tier: "primary" }]);
		assert.deepEqual(s.ingested, ["the page text"]);
		assert.equal(deriveInbox(s.inbox.events)[0]!.status, "activated");
	});

	it("refuses an unknown or already decided item, and a missing snapshot, without side effects", async () => {
		const s = setup(null);
		await assert.rejects(decideInboxItem(s.deps, "https://nope.org", "approved"), (e) => e instanceof InboxError && e.code === "not-found");
		await assert.rejects(decideInboxItem(s.deps, "https://a.org/x", "approved"), (e) => e instanceof InboxError && e.code === "snapshot-missing");
		assert.equal(s.inbox.events.length, 1);
		await decideInboxItem(s.deps, "https://a.org/x", "rejected");
		await assert.rejects(decideInboxItem(s.deps, "https://a.org/x", "approved"), (e) => e instanceof InboxError && e.code === "not-pending");
	});
});

describe("decideInboxItem: hardening", () => {
	it("two concurrent approvals ingest once", async () => {
		const s = setup();
		const results = await Promise.allSettled([
			decideInboxItem(s.deps, "https://a.org/x", "approved"),
			decideInboxItem(s.deps, "https://a.org/x", "approved"),
		]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		assert.deepEqual(s.ingested, ["the page text"]);
		assert.equal(s.inbox.events.filter((e) => e.type === "ingested").length, 1);
	});

	it("finds the item through an equivalent locator", async () => {
		const s = setup();
		await decideInboxItem(s.deps, "https://A.org/x/#frag", "rejected");
		assert.equal(deriveInbox(s.inbox.events)[0]!.status, "rejected");
	});

	it("a failed ingest leaves the item pending and retryable", async () => {
		const s = setup();
		let fail = true;
		const deps = { ...s.deps, ingest: async (src: { text: string }) => { if (fail) throw new Error("boom"); return s.deps.ingest({ locator: "x", text: src.text }); } };
		await assert.rejects(decideInboxItem(deps, "https://a.org/x", "approved"), /boom/);
		assert.equal(deriveInbox(s.inbox.events)[0]!.status, "pending");
		fail = false;
		assert.equal((await decideInboxItem(deps, "https://a.org/x", "approved")).nodesAdded, 4);
	});

	it("a non-integer count from the ingester is recorded as 0 instead of corrupting the log", async () => {
		const s = setup();
		const deps = { ...s.deps, ingest: async () => Number.NaN };
		assert.equal((await decideInboxItem(deps, "https://a.org/x", "approved")).nodesAdded, 0);
	});

	it("activate without a tier defaults to secondary; an empty title falls back to the locator", async () => {
		const s = setup();
		s.inbox.append({ type: "proposed", locator: "https://b.org/y", title: "", gapId: "g", foundBy: "cycle", cycleId: "c", snapshot: "h1", at: "t" });
		await decideInboxItem(s.deps, "https://b.org/y", "activated");
		assert.deepEqual(s.activated, [{ locator: "https://b.org/y", kind: "url-prefix", label: "https://b.org/y", tier: "secondary" }]);
	});

	it("two different locators decided concurrently both succeed", async () => {
		const s = setup();
		s.inbox.append({ type: "proposed", locator: "https://b.org/y", title: "Y", gapId: "g", foundBy: "cycle", cycleId: "c", snapshot: "h1", at: "t" });
		const r = await Promise.allSettled([decideInboxItem(s.deps, "https://a.org/x", "approved"), decideInboxItem(s.deps, "https://b.org/y", "approved")]);
		assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled"]);
		assert.equal(s.ingested.length, 2);
	});

	it("a reject during an in-flight approve is refused as in-progress and nothing is lost", async () => {
		const s = setup();
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const deps = { ...s.deps, ingest: async () => (await gate, 2) };
		const first = decideInboxItem(deps, "https://a.org/x", "approved");
		await assert.rejects(decideInboxItem(deps, "https://a.org/x", "rejected"), (e) => e instanceof InboxError && e.code === "in-progress");
		release();
		assert.equal((await first).nodesAdded, 2);
		assert.equal(deriveInbox(s.inbox.events)[0]!.status, "approved");
	});

	it("an invalid tier is refused before any side effect", async () => {
		const s = setup();
		await assert.rejects(decideInboxItem(s.deps, "https://a.org/x", "activated", "tertiary" as never), (e) => e instanceof InboxError && e.code === "bad-tier");
		assert.deepEqual(s.activated, []);
		assert.deepEqual(s.ingested, []);
		assert.equal(s.inbox.events.length, 1);
	});

	it("records decided before ingested, with a negative or fractional count as 0", async () => {
		for (const bad of [-3, 2.5]) {
			const s = setup();
			const deps = { ...s.deps, ingest: async () => bad };
			assert.equal((await decideInboxItem(deps, "https://a.org/x", "approved")).nodesAdded, 0);
			assert.deepEqual(s.inbox.events.slice(1).map((e) => e.type), ["decided", "ingested"]);
			assert.equal((s.inbox.events[2] as { nodesAdded: number }).nodesAdded, 0);
		}
	});

	it("refuses an unknown decision and an empty snapshot without side effects", async () => {
		const s = setup();
		await assert.rejects(decideInboxItem(s.deps, "https://a.org/x", "pending" as never), (e) => e instanceof InboxError && e.code === "bad-decision");
		const empty = setup("");
		await assert.rejects(decideInboxItem(empty.deps, "https://a.org/x", "activated"), (e) => e instanceof InboxError && e.code === "snapshot-missing");
		assert.deepEqual(empty.activated, []);
		assert.equal(s.inbox.events.length, 1);
	});
});
