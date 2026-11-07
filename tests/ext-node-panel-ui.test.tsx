// tests/ext-node-panel-ui.test.tsx
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NodePanelView, type NodePanelViewProps } from "../components/ext/node-panel-view.tsx";
import type { NodePanelData } from "../src/core/ext/node-panel-types.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

function data(over: Partial<NodePanelData> = {}): NodePanelData {
	return {
		node: { id: "n_c", name: "Gamma", statement: "Gamma holds.", aliases: ["G"] },
		explanation: {
			state: "current", ceiling: false, form: "short",
			current: { version: 1, body: "Gamma because [[n_a]].", author: "agent", noSource: true },
			proposal: null, linkNames: { n_a: "Alpha" },
		},
		trust: { level: "sourced", evidence: [{ sourceId: "s1", locator: "p. 3", quote: "Gamma is shown.", stance: "supports", tier: "primary", snapshotHash: "h" }] },
		concluding: [
			{ chainId: "arg_1", premises: [{ id: "n_a", name: "Alpha" }] },
			{ chainId: "arg_2", premises: [{ id: "n_b", name: "Beta" }] },
		],
		usedAsPremise: [{ chainId: "arg_3", coPremises: [], conclusion: { id: "n_d", name: "Delta" } }],
		citingLectures: [{ lectureId: "l1", title: "Lecture One" }],
		studySources: [{ documentId: "d".repeat(64), title: "Probability", page: 12 }],
		studyNotes: [],
		mentionedBy: [{ id: "n_d", name: "Delta" }],
		cards: [{ cardId: "c1", question: "Why gamma?", status: "active" }],
		review: { dueAt: null, reps: 2, pinned: false, retired: false },
		goals: [{ id: "g1", title: "Master Delta", status: "active", isTarget: false }],
		neighbourhood: {
			nodes: [
				{ id: "n_c", name: "Gamma", depth: 0 },
				{ id: "n_a", name: "Alpha", depth: 1 },
				{ id: "n_e", name: "Epsilon", depth: 2 },
			],
			edges: [{ from: "n_a", to: "n_c" }, { from: "n_e", to: "n_a" }],
		},
		availableActions: ["askInChat", "useAsGoalTarget"],
		...over,
	};
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const calls: string[] = [];

function props(over: Partial<NodePanelViewProps> = {}): NodePanelViewProps {
	return {
		data: data(), depth: 1, canBack: false, canForward: false, generating: false, error: null,
		onBack: () => calls.push("back"), onForward: () => calls.push("forward"), onClose: () => calls.push("close"),
		onNavigate: (id) => calls.push(`nav:${id}`), onDepth: (d) => calls.push(`depth:${d}`),
		onAction: (a) => calls.push(`action:${a}`), onGenerate: () => calls.push("generate"),
		onSaveEdit: (b) => calls.push(`save:${b}`), onCreateCard: (qn, a) => calls.push(`card:${qn}|${a}`), onDecide: (d, v) => calls.push(`decide:${d}:${v}`),
		...over,
	};
}
async function mount(p: NodePanelViewProps) {
	calls.length = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<NodePanelView {...p} />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (el: Element | null) => { assert.ok(el, "element to click exists"); await act(async () => { el.dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); };

it("shows the statement, trust with evidence, arguments, lectures, back-links, cards, review and goals (REQ-node-12)", async () => {
	await mount(props());
	const text = document.body.textContent ?? "";
	for (const expected of ["Gamma holds.", "sourced", "Gamma is shown.", "Alternative arguments", "Lecture One", "Delta", "Why gamma?", "Master Delta", "2"]) {
		assert.ok(text.includes(expected), `panel shows "${expected}"`);
	}
	assert.equal(q('[data-testid="panel-explanation"]')?.textContent?.includes("Gamma because"), true);
	assert.equal(q('[data-testid="explanation-nosource"]') !== null, true, "marks 'no source context'");
});

it("shows where in the learner's documents the node came from, linking to that page (REQ-study-10)", async () => {
	await mount(props());
	const link = q('[data-testid="panel-study-sources"] a');
	assert.equal(link?.textContent, "Probability, p. 12");
	assert.equal(link?.getAttribute("href"), `/study/${"d".repeat(64)}?page=12`);
	await act(async () => { root!.render(<NodePanelView {...props({ data: data({ studySources: [] }) })} />); });
	assert.match(q('[data-testid="panel-study-sources"]')?.textContent ?? "", /None\./);
});

it("a single argument is not labelled alternative", async () => {
	await mount(props({ data: data({ concluding: [{ chainId: "arg_1", premises: [{ id: "n_a", name: "Alpha" }] }] }) }));
	assert.equal((document.body.textContent ?? "").includes("Alternative arguments"), false);
});

it("clicking a mini-graph neighbour navigates; depth 2 nodes appear only at depth 2 (REQ-node-13)", async () => {
	await mount(props());
	assert.equal(q('[data-testid="minigraph-node-n_e"]'), null);
	await click(q('[data-testid="minigraph-node-n_a"]'));
	assert.deepEqual(calls, ["nav:n_a"]);
	await click(q('[data-testid="minigraph-depth-2"]'));
	assert.deepEqual(calls, ["nav:n_a", "depth:2"]);
	await act(async () => { root!.render(<NodePanelView {...props({ depth: 2 })} />); });
	assert.notEqual(q('[data-testid="minigraph-node-n_e"]'), null);
});

it("back and forward buttons follow the history flags", async () => {
	await mount(props({ canBack: true, canForward: false }));
	assert.equal(q('[data-testid="panel-back"]')?.hasAttribute("disabled"), false);
	assert.equal(q('[data-testid="panel-forward"]')?.hasAttribute("disabled"), true);
	await click(q('[data-testid="panel-back"]'));
	assert.deepEqual(calls, ["back"]);
});

it("clicking an inline node link in the explanation navigates (renderBody is replaceable)", async () => {
	await mount(props({ renderBody: () => <a href="#node:n_a">Alpha</a> }));
	await click(document.querySelector('[data-testid="panel-explanation"] a'));
	assert.deepEqual(calls, ["nav:n_a"]);
});

it("actions: only the available ones are enabled (REQ-node-14)", async () => {
	await mount(props());
	assert.equal(q('[data-testid="action-askInChat"]')?.hasAttribute("disabled"), false);
	assert.equal(q('[data-testid="action-verifyNow"]')?.hasAttribute("disabled"), true);
	await click(q('[data-testid="action-useAsGoalTarget"]'));
	assert.deepEqual(calls, ["action:useAsGoalTarget"]);
});

it("a missing explanation at the ceiling shows the statement and says why (REQ-node-05)", async () => {
	const base = data();
	await mount(props({ data: { ...base, explanation: { ...base.explanation, state: "missing", ceiling: true, current: null } } }));
	assert.match(q('[data-testid="explanation-ceiling"]')?.textContent ?? "", /ceiling/i);
	assert.equal((document.body.textContent ?? "").includes("Gamma holds."), true);
});

it("a missing explanation offers generation, and shows progress while generating", async () => {
	const base = data();
	const missing = { ...base, explanation: { ...base.explanation, state: "missing" as const, current: null } };
	await mount(props({ data: missing }));
	await click(q('[data-testid="explanation-generate"]'));
	assert.deepEqual(calls, ["generate"]);
	await act(async () => { root!.render(<NodePanelView {...props({ data: missing, generating: true })} />); });
	assert.notEqual(q('[data-testid="explanation-generating"]'), null);
});

it("a pending proposal can be approved or rejected (REQ-node-02)", async () => {
	const base = data();
	await mount(props({ data: { ...base, explanation: { ...base.explanation, proposal: { version: 3, body: "New agent text." } } } }));
	assert.equal(q('[data-testid="explanation-proposal"]')?.textContent?.includes("New agent text."), true);
	await click(q('[data-testid="proposal-approve"]'));
	await click(q('[data-testid="proposal-reject"]'));
	assert.deepEqual(calls, ["decide:approved:3", "decide:rejected:3"]);
});

it("the user can edit the explanation: the editor starts from the current text and Save sends the draft", async () => {
	await mount(props());
	await click(q('[data-testid="explanation-edit"]'));
	assert.ok(q('[data-testid="explanation-editor"]'));
	// linkedom neither reflects a controlled textarea's value nor drives React's onChange,
	// so typing is not simulated: Save sends the draft the editor was opened with.
	await click(q('[data-testid="explanation-save"]'));
	assert.deepEqual(calls, ["save:Gamma because [[n_a]]."]);
});

it("shows an error message", async () => {
	await mount(props({ error: "No model is configured" }));
	assert.match(q('[data-testid="panel-error"]')?.textContent ?? "", /No model is configured/);
});

it("create card opens an inline form that needs a question and an answer (REQ-node-14)", async () => {
	const base = data();
	await mount(props({ data: { ...base, availableActions: ["createCard", "askInChat"] } }));
	assert.equal(q('[data-testid="card-form"]'), null);
	await click(q('[data-testid="action-createCard"]'));
	assert.deepEqual(calls, [], "the form opens in the panel, no server action");
	assert.notEqual(q('[data-testid="card-form"]'), null);
	// linkedom does not drive onChange, so the fields stay empty and saving stays disabled
	assert.equal(q('[data-testid="card-save"]')?.hasAttribute("disabled"), true);
	await click(q('[data-testid="card-cancel"]'));
	assert.equal(q('[data-testid="card-form"]'), null);
});
