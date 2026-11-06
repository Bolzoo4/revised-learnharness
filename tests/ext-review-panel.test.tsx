// tests/ext-review-panel.test.tsx
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CardForm, CardGroups, CardRunner, NodesWithoutCard, NoCardForm, RunnerView } from "../components/ext/review-panel.tsx";
import {
	answerBody,
	askTutorBody,
	cardActions,
	cardFormReady,
	type CardView,
	emptyText,
	errorText,
	groupCardsByNode,
	newCardBody,
	NO_CARD_SHOWN,
	noCardView,
	type NodeRef,
	type PlanView,
	runnerCards,
	secondsSince,
	summaryLine,
	tutorBody,
} from "../components/ext/review-logic.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function mount(el: React.ReactElement): Promise<void> {
	if (root === undefined) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => root!.render(el));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	host = undefined;
});

const q = (sel: string) => {
	const el = host?.querySelector(sel);
	assert.ok(el, `element ${sel} exists`);
	return el as HTMLElement;
};
const buttonNamed = (text: string) => [...(host?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text) ?? null;
const click = async (el: Element | null) => {
	assert.ok(el, "element to click exists");
	await act(async () => {
		el.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
	});
};

const card = { nodeId: "n_a", name: "Alpha", cardId: "card_1", question: "What is Alpha?", answer: "Alpha holds." };

// ─── the card runner ───────────────────────────────────────────────────────

it("before the learner asks, the answer is not drawn and no rating is offered", async () => {
	await mount(<CardRunner card={card} revealed={false} busy={false} onReveal={() => {}} onRate={() => {}} onAsk={() => {}} />);
	assert.ok(host!.textContent?.includes("What is Alpha?"));
	assert.equal(host!.textContent?.includes("Alpha holds."), false, "the answer is hidden until Show answer");
	assert.ok(buttonNamed("Show answer"));
	for (const label of ["Again", "Hard", "Good", "Easy"]) assert.equal(buttonNamed(label), null, `${label} is not offered yet`);
});

it("Show answer reveals the answer and offers Again, Hard, Good, Easy in that order", async () => {
	const calls: string[] = [];
	await mount(
		<CardRunner card={card} revealed={true} busy={false} onReveal={() => calls.push("reveal")} onRate={(r) => calls.push(`rate:${r}`)} onAsk={() => {}} />,
	);
	assert.ok(host!.textContent?.includes("Alpha holds."));
	assert.equal(buttonNamed("Show answer"), null);
	const labels = [...host!.querySelectorAll("[role='group'] button")].map((b) => b.textContent);
	assert.deepEqual(labels, ["Again", "Hard", "Good", "Easy"]);
	await click(buttonNamed("Good"));
	assert.deepEqual(calls, ["rate:3"], "Good is rating 3");
});

it("the reveal button calls onReveal; the tutor button passes the card id", async () => {
	const calls: string[] = [];
	await mount(
		<CardRunner card={card} revealed={false} busy={false} onReveal={() => calls.push("reveal")} onRate={() => {}} onAsk={(id) => calls.push(`ask:${id}`)} />,
	);
	await click(buttonNamed("Show answer"));
	await click(buttonNamed("Ask the tutor"));
	assert.deepEqual(calls, ["reveal", "ask:card_1"]);
});

it("while a rating is being recorded the rating buttons are disabled", async () => {
	await mount(<CardRunner card={card} revealed={true} busy={true} onReveal={() => {}} onRate={() => {}} onAsk={() => {}} />);
	assert.equal(buttonNamed("Again")?.hasAttribute("disabled"), true);
});

// ─── the runner section ────────────────────────────────────────────────────

const plan = (over: Partial<PlanView> = {}): PlanView => ({
	items: [{ nodeId: "n_a", name: "Alpha", channel: "fixed", card: { cardId: "card_1", question: "What is Alpha?", answer: "Alpha holds." } }],
	deferred: [],
	needsCard: [],
	withoutCard: [],
	due: 1,
	plannedSec: 90,
	...over,
});

it("the section says it is loading before the plan arrives", async () => {
	await mount(
		<RunnerView plan={null} loadError={null} queue={[]} revealed={false} busy={false} error={null} onReveal={() => {}} onRate={() => {}} onAsk={() => {}} />,
	);
	assert.ok(host!.textContent?.includes("Loading today's plan"));
});

it("with nothing due it says so, with the deferred count and the nodes that still need a card", async () => {
	const p = plan({ items: [], due: 0, plannedSec: 0, deferred: [{ nodeId: "n_b", name: "Beta" }, { nodeId: "n_c", name: "Gamma" }], needsCard: [{ nodeId: "n_d", name: "Delta" }], withoutCard: [{ nodeId: "n_d", name: "Delta" }] });
	await mount(<RunnerView plan={p} loadError={null} queue={[]} revealed={false} busy={false} error={null} onReveal={() => {}} onRate={() => {}} onAsk={() => {}} />);
	const text = host!.textContent ?? "";
	assert.ok(text.includes("Nothing left to review today; 2 items deferred to tomorrow. 1 node has no card yet: write one or talk it through."), text);
	assert.equal(host!.querySelector("[data-testid='review-card']"), null);
});

it("the summary line reports the due count, planned items and minutes, and the deferred count", () => {
	assert.equal(summaryLine(plan()), "Due today: 1. Planned: 1 item, about 2 min. Deferred to tomorrow: 0.");
	assert.equal(summaryLine(plan({ items: [], plannedSec: 0, due: 0 })), "Due today: 0. Planned: 0 items, about 0 min. Deferred to tomorrow: 0.");
});

it("a load or rating error is shown with role alert", async () => {
	await mount(<RunnerView plan={plan()} loadError={null} queue={runnerCards(plan())} revealed={true} busy={false} error="rating must be 1, 2, 3 or 4" onReveal={() => {}} onRate={() => {}} onAsk={() => {}} />);
	assert.equal(host!.querySelector("[role='alert']")?.textContent, "rating must be 1, 2, 3 or 4");
});

it("the runner runs only fixed items that carry a card; a dialogic item is not run", () => {
	const p = plan({
		items: [
			{ nodeId: "n_a", name: "Alpha", channel: "fixed", card: { cardId: "card_1", question: "Q1", answer: "A1" } },
			{ nodeId: "n_b", name: "Beta", channel: "dialogic" },
		],
	});
	assert.deepEqual(runnerCards(p).map((c) => c.cardId), ["card_1"]);
});

it("the empty text names the deferred items and the nodes that have no card yet, in the singular and the plural", () => {
	const one = plan({ items: [], withoutCard: [{ nodeId: "n_b", name: "Beta" }], deferred: [{ nodeId: "n_c", name: "Gamma" }] });
	assert.equal(emptyText(one), "Nothing left to review today; 1 item deferred to tomorrow. 1 node has no card yet: write one or talk it through.");
	const two = plan({ items: [], withoutCard: [{ nodeId: "n_b", name: "Beta" }, { nodeId: "n_c", name: "Gamma" }] });
	assert.equal(emptyText(two), "Nothing left to review today. 2 nodes have no card yet: write one or talk it through.");
	assert.equal(emptyText(plan({ items: [] })), "Nothing left to review today.", "nothing to say about cards when every node has one");
});

// ─── nodes without a card: the bounded view and the request bodies ─────────

const nodesOf = (n: number): NodeRef[] => Array.from({ length: n }, (_, i) => ({ nodeId: `n_${i}`, name: `Node ${i}` }));

it("the nodes without a card are shown up to the bound, with the rest counted", () => {
	const view = noCardView(nodesOf(NO_CARD_SHOWN + 5));
	assert.equal(view.shown.length, NO_CARD_SHOWN);
	assert.equal(view.more, 5);
	assert.deepEqual(noCardView(nodesOf(3)), { shown: nodesOf(3), more: 0 });
});

it("a node with a blank name is shown by its id", () => {
	assert.deepEqual(noCardView([{ nodeId: "n_x", name: "  " }]).shown, [{ nodeId: "n_x", name: "n_x" }]);
});

it("Write a card trims the question and the answer and names the node; With the tutor posts only the node", () => {
	assert.deepEqual(newCardBody("n_a", "  Q?  ", " A. "), { nodeId: "n_a", question: "Q?", answer: "A." });
	assert.deepEqual(tutorBody("n_a"), { nodeId: "n_a" });
});

// ─── pure request and grouping logic ───────────────────────────────────────

it("a rating posts the node, the rating and the seconds the card was open (at least one)", () => {
	assert.deepEqual(answerBody("n_a", 4, 12), { nodeId: "n_a", rating: 4, durationSec: 12 });
	assert.equal(secondsSince(1_000, 1_400), 1, "a sub-second view counts as one second");
	assert.equal(secondsSince(1_000, 16_000), 15);
});

it("Ask the tutor posts the card id", () => {
	assert.deepEqual(askTutorBody("card_9"), { cardId: "card_9" });
});

it("a failed request shows the server's message, or the generic one when there is none", () => {
	assert.equal(errorText({ error: "unknown card" }), "unknown card");
	assert.equal(errorText({}), "The request failed. Try again.");
});

const cardOf = (over: Partial<CardView>): CardView => ({ id: "card_x", nodeId: "n_a", question: "Q", answer: "A", author: "user", status: "active", ...over });

it("cards are grouped by node, named from the graph, and the id is the fallback", () => {
	const cards = [cardOf({ id: "c1", nodeId: "n_z" }), cardOf({ id: "c2", nodeId: "n_a" }), cardOf({ id: "c3", nodeId: "n_z" })];
	const groups = groupCardsByNode(cards, new Map([["n_z", "Zeta"]]));
	assert.deepEqual(groups.map((g) => [g.name, g.cards.map((c) => c.id)]), [["n_a", ["c2"]], ["Zeta", ["c1", "c3"]]]);
});

it("a draft offers approve and reject (reject retires it); an active card offers retire; a retired card offers nothing", () => {
	assert.deepEqual(cardActions(cardOf({ status: "draft", author: "agent" })), ["approve", "retire"]);
	assert.deepEqual(cardActions(cardOf({ status: "active" })), ["retire"]);
	assert.deepEqual(cardActions(cardOf({ status: "retired" })), []);
});

it("the editor is ready only with a node, a question and an answer", () => {
	assert.equal(cardFormReady("", "Q", "A"), false);
	assert.equal(cardFormReady("n_a", "  ", "A"), false);
	assert.equal(cardFormReady("n_a", "Q", " "), false);
	assert.equal(cardFormReady("n_a", "Q", "A"), true);
});

// ─── the card list and editor ──────────────────────────────────────────────

it("the list shows the node name as the group heading, the status, and the actions of each card", async () => {
	const groups = groupCardsByNode(
		[cardOf({ id: "d1", status: "draft", author: "agent", question: "Draft Q" }), cardOf({ id: "a1", status: "active", question: "Active Q" })],
		new Map([["n_a", "Alpha"]]),
	);
	await mount(<CardGroups groups={groups} busy={false} onAction={() => {}} onAsk={() => {}} />);
	assert.equal(host!.querySelector("h3")?.textContent, "Alpha");
	assert.ok(host!.textContent?.includes("Draft · drafted by the tutor"));
	assert.ok(buttonNamed("Approve"));
	assert.ok(buttonNamed("Reject"), "a draft is rejected, not retired");
	assert.ok(buttonNamed("Retire"), "an active card is retired");
});

it("approve and reject call onAction with the card and the matching action", async () => {
	const calls: string[] = [];
	const groups = groupCardsByNode([cardOf({ id: "d1", status: "draft", author: "agent" })], new Map([["n_a", "Alpha"]]));
	await mount(<CardGroups groups={groups} busy={false} onAction={(id, a) => calls.push(`${a}:${id}`)} onAsk={(id) => calls.push(`ask:${id}`)} />);
	await click(buttonNamed("Approve"));
	await click(buttonNamed("Reject"));
	await click(buttonNamed("Ask the tutor"));
	assert.deepEqual(calls, ["approve:d1", "retire:d1", "ask:d1"]);
});

it("an empty list says what to do next", async () => {
	await mount(<CardGroups groups={[]} busy={false} onAction={() => {}} onAsk={() => {}} />);
	assert.ok(host!.textContent?.includes("No cards yet. Add one below"));
});

it("the card editor has visible labels, is disabled until complete, and submits once ready", async () => {
	const submits: number[] = [];
	const nodes = [{ id: "n_a", name: "Alpha" }];
	await mount(
		<CardForm nodes={nodes} nodeId="n_a" question="Q" answer="" busy={false} onNodeId={() => {}} onQuestion={() => {}} onAnswer={() => {}} onSubmit={() => submits.push(1)} />,
	);
	const labels = [...host!.querySelectorAll("label")].map((l) => l.textContent ?? "");
	for (const text of ["Node", "Question", "Answer"]) assert.ok(labels.some((l) => l.startsWith(text)), `label ${text}`);
	assert.equal(buttonNamed("Add card")?.hasAttribute("disabled"), true, "no answer yet");
	await mount(
		<CardForm nodes={nodes} nodeId="n_a" question="Q" answer="A" busy={false} onNodeId={() => {}} onQuestion={() => {}} onAnswer={() => {}} onSubmit={() => submits.push(1)} />,
	);
	assert.equal(buttonNamed("Add card")?.hasAttribute("disabled"), false);
	// linkedom does not submit a form on a button click; the form's submit event is what the page listens to.
	await act(async () => {
		q("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
	assert.equal(submits.length, 1);
});

// ─── nodes without a card: the section and its rows ────────────────────────

it("the card form for a node has visible labels and is disabled until complete", async () => {
	const submits: number[] = [];
	await mount(<NoCardForm nodeId="n_a" question="Q" answer="" busy={false} onQuestion={() => {}} onAnswer={() => {}} onSubmit={() => submits.push(1)} />);
	const labels = [...host!.querySelectorAll("label")].map((l) => l.textContent ?? "");
	for (const text of ["Question", "Answer"]) assert.ok(labels.some((l) => l.startsWith(text)), `label ${text}`);
	assert.equal(buttonNamed("Add card")?.hasAttribute("disabled"), true, "no answer yet");
	await mount(<NoCardForm nodeId="n_a" question="Q" answer="A" busy={false} onQuestion={() => {}} onAnswer={() => {}} onSubmit={() => submits.push(1)} />);
	assert.equal(buttonNamed("Add card")?.hasAttribute("disabled"), false);
	await act(async () => {
		q("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
	assert.equal(submits.length, 1);
});

it("the section lists each node by name, with Write a card as the primary and With the tutor as the secondary button", async () => {
	await mount(<NodesWithoutCard nodes={[{ nodeId: "n_b", name: "Beta" }]} onSaved={() => {}} onOpenChat={() => {}} />);
	assert.equal(host!.querySelector("h2")?.textContent, "Nodes without a card");
	assert.ok(host!.querySelector("li")?.textContent?.includes("Beta"));
	assert.ok(buttonNamed("Write a card")?.className.includes("bg-primary"), "the primary button is styled as primary");
	assert.equal(buttonNamed("With the tutor")?.className.includes("bg-primary"), false, "the tutor button is secondary");
	assert.equal(buttonNamed("Add card"), null, "the form is closed until Write a card is pressed");
});

it("Write a card opens the inline form for that node; the form is not open for other nodes", async () => {
	await mount(<NodesWithoutCard nodes={[{ nodeId: "n_b", name: "Beta" }, { nodeId: "n_c", name: "Gamma" }]} onSaved={() => {}} onOpenChat={() => {}} />);
	await click(buttonNamed("Write a card"));
	assert.ok(buttonNamed("Add card"), "the form opens");
	assert.equal(host!.querySelectorAll("form").length, 1, "one form, for the first node");
	assert.equal(host!.querySelectorAll("li")[1]?.querySelector("form"), null);
});

it("With the tutor posts the node id to the review session and opens the chat it returns", async () => {
	const bodies: string[] = [];
	const opened: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		bodies.push(`${url} ${String(init?.body)}`);
		return new Response(JSON.stringify({ chatId: "chat_9" }), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	try {
		await mount(<NodesWithoutCard nodes={[{ nodeId: "n_b", name: "Beta" }]} onSaved={() => {}} onOpenChat={(id) => opened.push(id)} />);
		await click(buttonNamed("With the tutor"));
		assert.deepEqual(bodies, ['/api/ext/review/session {"nodeId":"n_b"}']);
		assert.deepEqual(opened, ["chat_9"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

it("a failed tutor request shows the server's message and opens no chat", async () => {
	const opened: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unknown node" }), { status: 404, headers: { "Content-Type": "application/json" } })) as typeof fetch;
	try {
		await mount(<NodesWithoutCard nodes={[{ nodeId: "n_b", name: "Beta" }]} onSaved={() => {}} onOpenChat={(id) => opened.push(id)} />);
		await click(buttonNamed("With the tutor"));
		assert.equal(host!.querySelector("[role='alert']")?.textContent, "unknown node");
		assert.deepEqual(opened, []);
	} finally {
		globalThis.fetch = realFetch;
	}
});

it("with no node left the section says every node has a card; more than the bound says how many are left", async () => {
	await mount(<NodesWithoutCard nodes={[]} onSaved={() => {}} onOpenChat={() => {}} />);
	assert.ok(host!.textContent?.includes("Every node in today's plan has a card."));
	await mount(<NodesWithoutCard nodes={nodesOf(NO_CARD_SHOWN + 2)} onSaved={() => {}} onOpenChat={() => {}} />);
	assert.equal(host!.querySelectorAll("li").length, NO_CARD_SHOWN);
	assert.ok(host!.textContent?.includes("2 more"));
});
