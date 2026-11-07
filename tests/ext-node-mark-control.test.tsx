// tests/ext-node-mark-control.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
	clearNodeMarks,
	nodeMarksOf,
	NodeMarkView,
	setNodeMark,
	type NodeMark,
} from "../components/ext/node-mark-control.tsx";

const expandHere: NodeMark = { id: "mark_1", scope: { kind: "node", id: "n_a" }, mark: "expand", author: "user" };
const otherNode: NodeMark = { id: "mark_2", scope: { kind: "node", id: "n_b" }, mark: "stop", author: "user" };
const subtreeAbove: NodeMark = { id: "mark_3", scope: { kind: "subtree", id: "n_a" }, mark: "hold", author: "agent" };

function render(props: Partial<Parameters<typeof NodeMarkView>[0]> = {}): Document {
	const full = { current: null, busy: false, error: null, onSet: () => {}, onClear: () => {}, ...props };
	return parseHTML(`<html><body>${renderToStaticMarkup(<NodeMarkView {...full} />)}</body></html>`).document as unknown as Document;
}
const button = (doc: Document, text: string) => [...doc.querySelectorAll("button")].find((b) => b.textContent === text);

/** A fake fetch that records every call and answers ok unless told otherwise. */
function fakeFetch(answers: Array<{ ok: boolean }> = []) {
	const calls: Array<{ method: string; url: string; body: unknown }> = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const answer = answers.shift() ?? { ok: true };
		return { ok: answer.ok, status: answer.ok ? 200 : 400, json: async () => ({}) } as Response;
	}) as typeof fetch;
	return { calls, fetcher };
}

describe("nodeMarksOf", () => {
	it("keeps only the marks whose scope is this node", () => {
		assert.deepEqual(nodeMarksOf([expandHere, otherNode, subtreeAbove], "n_a"), [expandHere]);
		assert.deepEqual(nodeMarksOf([], "n_a"), []);
	});
});

describe("NodeMarkView", () => {
	it("shows the node's current mark and who set it", () => {
		const text = render({ current: expandHere }).body.textContent ?? "";
		assert.ok(text.includes("Current mark: expand, set by you"), text);
	});

	it("says there is no mark when none is set", () => {
		assert.ok((render().body.textContent ?? "").includes("Current mark: none"));
	});

	it("offers Expand, Hold, Stop and Clear; Clear is disabled when no mark is set", () => {
		const doc = render();
		for (const label of ["Expand", "Hold", "Stop"]) assert.ok(button(doc, label), `a ${label} button`);
		assert.equal(button(doc, "Clear")?.hasAttribute("disabled"), true);
		assert.equal(button(render({ current: expandHere }), "Clear")?.hasAttribute("disabled"), false);
	});

	it("shows the error text when a change fails", () => {
		const text = render({ error: "Something went wrong. Please try again." }).body.textContent ?? "";
		assert.ok(text.includes("Something went wrong. Please try again."));
	});
});

describe("setNodeMark", () => {
	it("writes the new mark with the node as scope, then clears the node's previous mark", async () => {
		const { calls, fetcher } = fakeFetch();
		const ok = await setNodeMark("n_a", "hold", [expandHere], fetcher);
		assert.equal(ok, true);
		assert.deepEqual(calls[0], {
			method: "POST",
			url: "/api/ext/research/marks",
			body: { scope: { kind: "node", id: "n_a" }, mark: "hold" },
		});
		assert.equal(calls[1]?.method, "DELETE");
		assert.equal(calls[1]?.url, "/api/ext/research/marks");
		assert.deepEqual(calls[1]?.body, { id: "mark_1" });
		assert.equal(calls.length, 2);
	});

	it("when the write fails it reports failure and clears nothing", async () => {
		const { calls, fetcher } = fakeFetch([{ ok: false }]);
		assert.equal(await setNodeMark("n_a", "stop", [expandHere], fetcher), false);
		assert.equal(calls.length, 1, "no DELETE after a failed write");
	});

	it("with no previous mark it only writes", async () => {
		const { calls, fetcher } = fakeFetch();
		assert.equal(await setNodeMark("n_a", "expand", [], fetcher), true);
		assert.equal(calls.length, 1);
	});
});

describe("clearNodeMarks", () => {
	it("clears every mark on this node", async () => {
		const { calls, fetcher } = fakeFetch();
		assert.equal(await clearNodeMarks([expandHere], fetcher), true);
		assert.deepEqual(calls.map((c) => [c.method, c.body]), [["DELETE", { id: "mark_1" }]]);
	});

	it("reports failure when a clear fails", async () => {
		const { fetcher } = fakeFetch([{ ok: false }]);
		assert.equal(await clearNodeMarks([expandHere], fetcher), false);
	});
});

describe("the node detail card in the graph", () => {
	it("mounts the mark control once, under the trust badge, in the same card", () => {
		const source = readFileSync(new URL("../components/graph-view.tsx", import.meta.url), "utf8");
		assert.equal(source.split("<NodeMarkControl").length - 1, 1, "one mount");
		assert.ok(source.includes('import { NodeMarkControl } from "@/components/ext/node-mark-control.tsx";'), "one import");
		const trust = source.indexOf("<TrustBadge nodeId={selected.node.id} />");
		const mark = source.indexOf("<NodeMarkControl nodeId={selected.node.id} />");
		assert.ok(trust > 0 && mark > trust, "the mark control follows the trust badge");
		assert.ok(source.slice(trust, mark).split("\n").length <= 3, "it sits in the same card block");
	});
});
