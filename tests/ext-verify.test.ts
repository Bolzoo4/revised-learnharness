// tests/ext-verify.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceTextReader, Verifier, VerifierRun } from "../src/core/ext/ports.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { deriveTrustMap } from "../src/core/ext/trust.ts";
import { verifyNodes, VERIFY_BATCH_SIZE } from "../src/core/ext/verify.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { fakeGate, memSnapshotStore, memSourcesStore, memVerificationStore, node } from "./helpers/ext-fakes.ts";

const TEXT = "The sum of the angles of a triangle in the Euclidean plane is one hundred and eighty degrees.";
const QUOTE = "sum of the angles of a triangle in the Euclidean plane";

const book: SourceEntry = { id: "lib_book", kind: "pdf", locator: "/books/geo.pdf", tier: "primary", label: "Geometry", status: "active", addedBy: "user" };
const wiki: SourceEntry = { id: "lib_wiki", kind: "url-prefix", locator: "https://en.wikipedia.org/", tier: "secondary", label: "Wikipedia", status: "active", addedBy: "user" };

function setup(opts: { sources?: SourceEntry[]; texts?: Record<string, string>; nodeIds?: string[] } = {}) {
	const graphStore = createMemoryGraphStore();
	for (const id of opts.nodeIds ?? ["n1"]) graphStore.appendNode(node(id));
	const sourcesStore = memSourcesStore(opts.sources ?? [book, wiki]);
	const snapshotStore = memSnapshotStore();
	const verificationStore = memVerificationStore();
	const costGate = fakeGate();
	const reads: string[] = [];
	const texts = opts.texts ?? { "/books/geo.pdf": TEXT, "https://en.wikipedia.org/wiki/Triangle": TEXT };
	const reader: SourceTextReader = { read: async (ref) => (reads.push(ref), texts[ref] ?? null) };
	return { graphStore, sourcesStore, snapshotStore, verificationStore, costGate, reader, reads };
}
function verifierReturning(output: VerifierRun["output"], calls: unknown[] = []): Verifier {
	return { run: async (input) => (calls.push(input), { output, checker: "test:model" }) };
}
const supports = (sourceRef: string, quote = QUOTE) => ({ sourceRef, locator: "p. 3", quote, stance: "supports" as const });

describe("verifyNodes", () => {
	it("a quote confirmed in a primary library PDF yields sourced, with snapshot hash and code-assigned tier", async () => {
		const s = setup();
		const report = await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book")] }], proposedSources: [] }), now: () => "t1" });
		assert.deepEqual(report.checked, ["n1"]);
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type, "checked");
		if (event.type !== "checked") return;
		assert.equal(event.outcome, "sourced");
		assert.equal(event.checker, "test:model");
		assert.equal(event.evidence[0]!.tier, "primary");
		assert.equal(event.evidence[0]!.sourceId, "lib_book");
		assert.equal(event.evidence[0]!.snapshot, "h1");
		assert.equal(s.snapshotStore.texts.get("h1"), TEXT);
		assert.deepEqual(s.reads, ["/books/geo.pdf"], "a library PDF is read by its locator");
	});

	it("discards a quote that is not in the re-read source (quote_not_found) and never promotes", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book", "the angles of a triangle sum to three hundred degrees")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "unverified");
		assert.deepEqual(event.type === "checked" ? event.discarded : [], [{ sourceRef: "lib_book", reason: "quote_not_found" }]);
		assert.equal(event.type === "checked" ? event.evidence.length : -1, 0);
	});

	it("an unreadable source discards the evidence with source_unreadable", async () => {
		const s = setup({ texts: {} });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.deepEqual(event.type === "checked" ? event.discarded : [], [{ sourceRef: "lib_book", reason: "source_unreadable" }]);
	});

	it("a source outside the active library is unvetted and cannot make a node sourced", async () => {
		const s = setup({ texts: { "https://blog.example/post": TEXT } });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://blog.example/post")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.evidence[0]!.tier, "unvetted");
		assert.equal(event.type === "checked" && event.outcome, "unverified");
	});

	it("a proposed library entry is ignored until activated", async () => {
		const s = setup({ sources: [{ ...wiki, status: "proposed", addedBy: "agent" }] });
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://en.wikipedia.org/wiki/Triangle")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.evidence[0]!.tier, "unvetted");
	});

	it("two independent secondaries make a node sourced; the tier comes from the library, not the model", async () => {
		const s = setup({
			sources: [wiki, { id: "lib_mw", kind: "url-prefix", locator: "https://mathworld.wolfram.com/", tier: "secondary", label: "MathWorld", status: "active", addedBy: "user" }],
			texts: { "https://en.wikipedia.org/wiki/Triangle": TEXT, "https://mathworld.wolfram.com/Triangle.html": TEXT },
		});
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("https://en.wikipedia.org/wiki/Triangle"), supports("https://mathworld.wolfram.com/Triangle.html")] }], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "sourced");
	});

	it("a verifier that throws appends check_failed for the batch and leaves a prior sourced level intact (REQ-src-12)", async () => {
		const s = setup();
		s.verificationStore.appendEvent({ type: "checked", nodeId: "n1", outcome: "sourced", evidence: [], discarded: [], checker: "m", at: "t0" });
		const report = await verifyNodes(["n1"], { ...s, verifier: { run: async () => { throw new Error("network down"); } } });
		assert.deepEqual(report.failed, ["n1"]);
		const last = s.verificationStore.events.at(-1)!;
		assert.equal(last.type, "check_failed");
		assert.equal(deriveTrustMap(s.verificationStore.events).get("n1")?.level, "sourced");
	});

	it("unparseable verifier output is a failed check, not an unverified result", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning(null) });
		const last = s.verificationStore.events[0]!;
		assert.equal(last.type === "check_failed" && last.reason, "unparseable_output");
	});

	it("a node the verifier returned nothing for is a completed check with no evidence", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }) });
		const event = s.verificationStore.events[0]!;
		assert.equal(event.type === "checked" && event.outcome, "unverified");
	});

	it("batches nodes by VERIFY_BATCH_SIZE", async () => {
		const ids = Array.from({ length: VERIFY_BATCH_SIZE + 2 }, (_, i) => `n${i + 1}`);
		const s = setup({ nodeIds: ids });
		const calls: { nodes: unknown[] }[] = [];
		await verifyNodes(ids, { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(calls.map((c) => c.nodes.length), [VERIFY_BATCH_SIZE, 2]);
	});

	it("reports unknown node ids and does not call the verifier for them", async () => {
		const s = setup();
		const calls: unknown[] = [];
		const report = await verifyNodes(["ghost"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(report.unknown, ["ghost"]);
		assert.equal(calls.length, 0);
	});

	it("passes only ACTIVE library entries to the verifier", async () => {
		const s = setup({ sources: [book, { ...wiki, status: "proposed", addedBy: "agent" }] });
		const calls: { library: SourceEntry[] }[] = [];
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(calls[0]!.library.map((e) => e.id), ["lib_book"]);
	});

	it("records proposed sources as proposed agent entries without activating them", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [{ kind: "url-prefix", locator: "https://mathworld.wolfram.com/", label: "MathWorld" }] }) });
		const added = s.sourcesStore.read().find((e) => e.locator === "https://mathworld.wolfram.com/");
		assert.equal(added?.status, "proposed");
		assert.equal(added?.addedBy, "agent");
	});

	it("does nothing when the daily ceiling is already reached (REQ-src-16)", async () => {
		const s = setup();
		s.costGate.open = false;
		const calls: unknown[] = [];
		const report = await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [], proposedSources: [] }, calls) });
		assert.deepEqual(report.skippedBudget, ["n1"]);
		assert.equal(calls.length, 0);
		assert.equal(s.verificationStore.events.length, 0);
	});

	it("records spend and aborts the run when the ceiling is crossed mid-run", async () => {
		const s = setup();
		const verifier: Verifier = {
			run: async (_input, hooks) => {
				hooks.onCostUsd(5);
				s.costGate.open = false;
				hooks.onCostUsd(0.1);
				assert.equal(hooks.signal.aborted, true);
				throw new Error("aborted");
			},
		};
		const report = await verifyNodes(["n1"], { ...s, verifier });
		assert.deepEqual(s.costGate.recorded, [{ usd: 5, source: "verification" }, { usd: 0.1, source: "verification" }]);
		assert.deepEqual(report.failed, ["n1"]);
		const last = s.verificationStore.events[0]!;
		assert.equal(last.type === "check_failed" && last.reason, "budget_exhausted");
	});

	it("reads each source once per batch even when cited twice", async () => {
		const s = setup();
		await verifyNodes(["n1"], { ...s, verifier: verifierReturning({ results: [{ nodeId: "n1", evidence: [supports("lib_book"), supports("/books/geo.pdf", "the Euclidean plane is one hundred and eighty degrees")] }], proposedSources: [] }) });
		assert.deepEqual(s.reads, ["/books/geo.pdf"]);
	});
});
