// tests/ext-session-notes-wiring.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNodePanel } from "../src/core/ext/node-panel.ts";
import { learnerTextsOf, studyBlockForNodes, withStudyBlock, type SessionNotes } from "../src/core/ext/session-notes.ts";
import { exercisePrompt } from "../src/agent/ext/practice/exercise-writer.ts";
import { focusedNodeReviewInstructions, focusedReviewInstructions } from "../src/agent/ext/review-instructions.ts";
import type { LhMarkerMessage, LhMessage } from "../src/core/native-messages.ts";
import { graphWith, node } from "./helpers/ext-node-fixtures.ts";

const NOW = "2026-11-07T10:00:00.000Z";
const notes: SessionNotes = {
	chat_a: { text: "Intuition first, no formulas.", updatedAt: NOW, edited: false },
	chat_b: { text: "Worked examples.", updatedAt: NOW, edited: true },
};
const titles: Record<string, string> = { chat_a: "Kant lesson", chat_b: "Hume lesson", chat_c: "Plain chat" };
const titleOf = (id: string) => titles[id] ?? id;

describe("session notes: the study block for nodes (REQ-sn-05)", () => {
	const prov = (...chatIds: string[]) => chatIds.map((chatId) => ({ chatId, messageId: "m" }));
	it("titles each note with its chat and puts the labelled block first", () => {
		const block = studyBlockForNodes([{ provenance: prov("chat_a") }, { provenance: prov("chat_b") }], notes, titleOf);
		assert.match(block, /^Study preferences/);
		assert.match(block, /- \[Kant lesson\] Intuition first, no formulas\./);
		assert.match(block, /- \[Hume lesson\] Worked examples\./);
	});
	it("is empty when none of the nodes' chats has a note", () => {
		assert.equal(studyBlockForNodes([{ provenance: prov("chat_c") }], notes, titleOf), "");
		assert.equal(studyBlockForNodes([], notes, titleOf), "");
	});
});

describe("session notes: the upstream Practice context (REQ-sn-05)", () => {
	it("puts the block ahead of the session context and leaves an empty block alone", () => {
		const marker = { id: "x", role: "custom", customType: "graph-context", content: "[Session context] picked…", display: true, details: {}, timestamp: 1 } as LhMarkerMessage;
		const block = "Study preferences (...):\n- [Kant lesson] Intuition first.";
		assert.equal(withStudyBlock(marker, block).content, `${block}\n\n[Session context] picked…`);
		assert.equal(withStudyBlock(marker, ""), marker);
	});
});

describe("session notes: what the learner said (REQ-sn-02)", () => {
	it("takes only the user's text, from strings and text blocks", () => {
		const messages = [
			{ id: "1", role: "user", content: "no formulas please", timestamp: 1 },
			{ id: "2", role: "assistant", content: [{ type: "text", text: "TEACHER PROSE" }], timestamp: 2 },
			{ id: "3", role: "user", content: [{ type: "text", text: "and examples" }, { type: "image", data: "x" }], timestamp: 3 },
			{ id: "4", role: "user", content: "   ", timestamp: 4 },
		] as unknown as LhMessage[];
		assert.deepEqual(learnerTextsOf(messages), ["no formulas please", "and examples"]);
	});
});

describe("session notes: the other sessions that work on a node (REQ-sn-05)", () => {
	it("exercise prompt carries the block first when there is one", () => {
		const input = { goalTitle: "G", nodes: [{ id: "n1", name: "N", statement: "S" }], targetNodeIds: ["n1"], count: 1, feedback: null };
		const plain = exercisePrompt(input);
		const withNotes = exercisePrompt({ ...input, studyNotes: "Study preferences (x):\n- [T] No formulas." });
		assert.ok(withNotes.startsWith("Study preferences (x):"));
		assert.equal(withNotes.slice(withNotes.indexOf("Goal:")), plain);
		assert.equal(exercisePrompt({ ...input, studyNotes: "" }), plain);
	});

	it("a card's tutor session shows the node's study preferences", () => {
		const focus = { nodeId: "n1", nodeName: "N", nodeStatement: "S", question: "Q?", answer: "A", studyNotes: "Study preferences (x):\n- [T] No formulas." };
		assert.match(focusedReviewInstructions(focus), /Study preferences \(x\):/);
		assert.doesNotMatch(focusedReviewInstructions({ ...focus, studyNotes: undefined }), /Study preferences/);
	});

	it("a node tutor session shows the node's study preferences", () => {
		const focus = { nodeId: "n1", nodeName: "N", nodeStatement: "S", studyNotes: "Study preferences (x):\n- [T] Worked examples." };
		assert.match(focusedNodeReviewInstructions(focus), /Study preferences \(x\):/);
		assert.doesNotMatch(focusedNodeReviewInstructions({ ...focus, studyNotes: undefined }), /Study preferences/);
	});
});

describe("session notes: the node panel (REQ-sn-06)", () => {
	it("passes the sources' notes through to the panel data, and an absent source yields none", () => {
		const graph = graphWith([node("n1", "N", "S")], []);
		const base = { graph, explanationEvents: [], goalEvents: [], costAllowed: true, availableActions: [] };
		const withSource = buildNodePanel("n1", {
			...base,
			sources: { studyNotes: () => [{ chatId: "chat_a", chatTitle: "Kant lesson", text: "No formulas.", edited: false, updatedAt: NOW }] },
		});
		assert.deepEqual(withSource?.studyNotes, [{ chatId: "chat_a", chatTitle: "Kant lesson", text: "No formulas.", edited: false, updatedAt: NOW }]);
		assert.deepEqual(buildNodePanel("n1", { ...base, sources: {} })?.studyNotes, []);
	});
});

