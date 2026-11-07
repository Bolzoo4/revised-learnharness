// tests/ext-session-notes-ui.test.tsx
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

const NOTE = { chatId: "chat_a", chatTitle: "Kant lesson", text: "Intuition before formulas.", edited: false, updatedAt: "2026-11-07T10:00:00.000Z" };

function data(over: Partial<NodePanelData> = {}): NodePanelData {
	return {
		node: { id: "n_c", name: "Gamma", statement: "Gamma holds.", aliases: [] },
		explanation: { state: "missing", ceiling: false, form: "short", current: null, proposal: null, linkNames: {} },
		trust: { level: "unverified", evidence: [] },
		concluding: [],
		usedAsPremise: [],
		citingLectures: [],
		studySources: [],
		studyNotes: [NOTE],
		mentionedBy: [],
		cards: [],
		review: null,
		goals: [],
		neighbourhood: { nodes: [{ id: "n_c", name: "Gamma", depth: 0 }], edges: [] },
		availableActions: [],
		...over,
	};
}

const calls: string[] = [];
function props(over: Partial<NodePanelViewProps> = {}): NodePanelViewProps {
	const noop = () => undefined;
	return {
		data: data(),
		depth: 1,
		canBack: false,
		canForward: false,
		generating: false,
		error: null,
		onBack: noop,
		onForward: noop,
		onClose: noop,
		onNavigate: noop,
		onDepth: noop,
		onAction: noop,
		onGenerate: noop,
		onSaveEdit: noop,
		onCreateCard: noop,
		onDecide: noop,
		onSaveStudyNote: (chatId, text) => calls.push(`save ${chatId} ${text}`),
		onClearStudyNote: (chatId) => calls.push(`clear ${chatId}`),
		...over,
	};
}

let root: Root | undefined;
let host: HTMLElement | undefined;
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

it("shows the study note of each source chat, titled by the chat (REQ-sn-06)", async () => {
	await mount(props());
	const section = q('[data-testid="panel-study-notes"]');
	assert.match(section?.textContent ?? "", /How you wanted to study this/);
	assert.match(section?.textContent ?? "", /Kant lesson/);
	assert.match(section?.textContent ?? "", /Intuition before formulas\./);
});

it("says None when the node's chats have no note", async () => {
	await mount(props({ data: data({ studyNotes: [] }) }));
	assert.match(q('[data-testid="panel-study-notes"]')?.textContent ?? "", /None\./);
});

it("the learner opens the edit box and saves through the handler with the note's text", async () => {
	await mount(props());
	await click(q('[data-testid="study-note-edit"]'));
	assert.ok(q('[data-testid="study-note-input"]'), "the edit box opens");
	await click(q('[data-testid="study-note-save"]'));
	assert.deepEqual(calls, ["save chat_a Intuition before formulas."]);
});

it("the learner clears a note through the handler", async () => {
	await mount(props());
	await click(q('[data-testid="study-note-clear"]'));
	assert.deepEqual(calls, ["clear chat_a"]);
});
