/**
 * The agent side of the extension's prompt overrides: resolveExtPrompt's rules,
 * the fresh read per call, the data block that is always appended after the
 * body, and one wired builder per editable agent.
 *
 * TEST-DIR ISOLATION: LH_DATA_DIR is the data-location seam, read at config.ts
 * module load, so it is set before any app-module import (all dynamic below).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-prompt-override-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
const { resolveExtPrompt } = await import("../src/agent/ext/prompt-override.ts");
const { verifierInstructions, VERIFIER_INSTRUCTIONS } = await import("../src/agent/ext/verifier.ts");
const { gapResearchInstructions, GAP_RESEARCH_INSTRUCTIONS } = await import("../src/agent/ext/gap-research.ts");
const { watchClassifyInstructions, WATCH_CLASSIFY_INSTRUCTIONS } = await import("../src/agent/ext/watch-classify.ts");
const { researchInstructions, RESEARCH_INSTRUCTIONS } = await import("../src/agent/ext/research-instructions.ts");
const { reviewDailyInstructions, focusedReviewInstructions, focusedNodeReviewInstructions, REVIEW_INSTRUCTIONS, REVIEW_CARD_BODY, REVIEW_NODE_BODY } = await import(
	"../src/agent/ext/review-instructions.ts"
);
const { studyPrompt, STUDY_INSTRUCTIONS } = await import("../src/agent/ext/study/study-instructions.ts");
const { officeHoursInstructions, OFFICE_HOURS_INSTRUCTIONS } = await import("../src/agent/ext/practice/office-hours-instructions.ts");
const { debriefStyle, loadDebriefStyle } = await import("../src/agent/ext/debrief-writer.ts");
const { explanationStyle, loadStyleGuide } = await import("../src/agent/ext/explanation-writer.ts");

const SWITCHES = path.join(TMP_DATA, "ext", "prompt-switches.json");
const overrideFile = (id: string) => path.join(PROMPTS_OVERRIDE_DIR, "ext", `${id}.md`);

function setSwitches(value: unknown): void {
	fs.mkdirSync(path.dirname(SWITCHES), { recursive: true });
	fs.writeFileSync(SWITCHES, typeof value === "string" ? value : JSON.stringify(value));
}
function setOverride(id: string, text: string): void {
	fs.mkdirSync(path.dirname(overrideFile(id)), { recursive: true });
	fs.writeFileSync(overrideFile(id), text);
}
function reset(): void {
	fs.rmSync(path.join(TMP_DATA, "ext"), { recursive: true, force: true });
	fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
}

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(reset);

describe("resolveExtPrompt", () => {
	it("returns the default when the switch is off, even with a file", () => {
		setOverride("verifier", "MINE");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
		setSwitches({ verifier: false });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
	});

	it("returns the default when the switch is on but there is no file", () => {
		setSwitches({ verifier: true });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
	});

	it("returns the file when the switch is on and the file exists", () => {
		setSwitches({ verifier: true });
		setOverride("verifier", "MINE");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "MINE");
	});

	it("returns an enabled empty file as empty text (it does not fall back to the default)", () => {
		setSwitches({ verifier: true });
		setOverride("verifier", "");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "");
	});

	it("returns the default when the override file cannot be read", () => {
		setSwitches({ verifier: true });
		fs.mkdirSync(overrideFile("verifier"), { recursive: true }); // a directory where the file should be
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
	});

	it("returns the default for an id outside the catalog, even with a switch and a file", () => {
		setSwitches({ nope: true });
		setOverride("nope", "MINE");
		assert.equal(resolveExtPrompt("nope", "DEFAULT"), "DEFAULT");
		assert.equal(resolveExtPrompt("../verifier", "DEFAULT"), "DEFAULT");
	});

	it("treats a malformed switch file as all switches off", () => {
		setOverride("verifier", "MINE");
		setSwitches("{not json");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
		setSwitches([true]);
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
	});

	it("counts only the switch value true (not truthy strings or numbers)", () => {
		setOverride("verifier", "MINE");
		setSwitches({ verifier: "yes" });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
		setSwitches({ verifier: 1 });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
	});

	it("reads fresh on every call: an edited file, a toggled switch", () => {
		setSwitches({ verifier: true });
		setOverride("verifier", "FIRST");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "FIRST");
		setOverride("verifier", "SECOND");
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "SECOND");
		setSwitches({ verifier: false });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT");
		setSwitches({ verifier: true });
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "SECOND");
	});
});

describe("each wired agent runs the override through its public builder", () => {
	it("verifier", () => {
		assert.equal(verifierInstructions(), VERIFIER_INSTRUCTIONS);
		setSwitches({ verifier: true });
		setOverride("verifier", "MINE verifier");
		assert.equal(verifierInstructions(), "MINE verifier");
	});

	it("gap researcher", () => {
		assert.equal(gapResearchInstructions(), GAP_RESEARCH_INSTRUCTIONS);
		setSwitches({ "gap-researcher": true });
		setOverride("gap-researcher", "MINE gap");
		assert.equal(gapResearchInstructions(), "MINE gap");
	});

	it("watch classifier", () => {
		assert.equal(watchClassifyInstructions(), WATCH_CLASSIFY_INSTRUCTIONS);
		setSwitches({ "watch-classifier": true });
		setOverride("watch-classifier", "MINE watch");
		assert.equal(watchClassifyInstructions(), "MINE watch");
	});

	it("research console (the instructions createResearchAgent passes)", () => {
		assert.equal(researchInstructions(), RESEARCH_INSTRUCTIONS);
		setSwitches({ "research-chat": true });
		setOverride("research-chat", "MINE research");
		assert.equal(researchInstructions(), "MINE research");
	});

	it("daily review", () => {
		assert.equal(reviewDailyInstructions(), REVIEW_INSTRUCTIONS);
		setSwitches({ "review-daily": true });
		setOverride("review-daily", "MINE daily");
		assert.equal(reviewDailyInstructions(), "MINE daily");
	});

	it("study assistant", () => {
		const ctx = {
			chatId: "chat_1",
			chatStore: { getChat: () => ({ messages: [] }) },
			document: () => ({ id: "doc_1", title: "Notes", pageCount: 3 }),
			pageText: () => null,
			search: () => [],
		};
		assert.equal(studyPrompt(ctx).startsWith(STUDY_INSTRUCTIONS), true);
		setSwitches({ "study-assistant": true });
		setOverride("study-assistant", "MINE study");
		assert.ok(studyPrompt(ctx).startsWith("MINE study"));
	});

	it("office hours", () => {
		assert.equal(officeHoursInstructions(null), OFFICE_HOURS_INSTRUCTIONS);
		setSwitches({ "office-hours": true });
		setOverride("office-hours", "MINE office");
		assert.equal(officeHoursInstructions(null), "MINE office");
	});

	it("debrief style guide and explanation style guide", () => {
		assert.equal(debriefStyle(), loadDebriefStyle());
		assert.equal(explanationStyle(), loadStyleGuide());
		setSwitches({ "debrief-style": true, "explanation-style": true });
		setOverride("debrief-style", "MINE debrief");
		setOverride("explanation-style", "MINE explanation");
		assert.equal(debriefStyle(), "MINE debrief");
		assert.equal(explanationStyle(), "MINE explanation");
	});

	it("a style file without its switch is NOT used (the switch decides, not the file)", () => {
		setOverride("debrief-style", "UNSWITCHED");
		setOverride("explanation-style", "UNSWITCHED");
		assert.notEqual(debriefStyle(), "UNSWITCHED");
		assert.notEqual(explanationStyle(), "UNSWITCHED");
	});
});

describe("the per-run data block is always appended after the body", () => {
	const card = { nodeId: "n_card", nodeName: "Alpha", nodeStatement: "Alpha holds.", question: "What is Alpha?", answer: "Alpha holds, always." };

	it("the card tutor keeps the card after an override body", () => {
		setSwitches({ "review-card": true });
		setOverride("review-card", "MY CARD BODY");
		const text = focusedReviewInstructions(card);
		assert.ok(text.startsWith("MY CARD BODY"));
		assert.ok(text.endsWith("Card answer: Alpha holds, always."));
		assert.ok(text.includes("Node id: n_card"));
	});

	it("an empty card body still carries the card (the data cannot be dropped by an edit)", () => {
		setSwitches({ "review-card": true });
		setOverride("review-card", "");
		const text = focusedReviewInstructions(card);
		assert.ok(text.includes("Card question: What is Alpha?"));
		assert.ok(text.includes("Node id: n_card"));
	});

	it("the card default body is the static text the code ships", () => {
		assert.ok(focusedReviewInstructions(card).startsWith(`${REVIEW_CARD_BODY}\n\n`));
	});

	it("the node tutor keeps the node after an override body, and after an empty one", () => {
		setSwitches({ "review-node": true });
		setOverride("review-node", "MY NODE BODY");
		const text = focusedNodeReviewInstructions({ nodeId: "c", nodeName: "Gamma", nodeStatement: "Gamma holds.", explanation: "Third letter." });
		assert.ok(text.startsWith("MY NODE BODY"));
		assert.ok(text.endsWith("Explanation: Third letter."));
		setOverride("review-node", "");
		const bare = focusedNodeReviewInstructions({ nodeId: "c", nodeName: "Gamma", nodeStatement: "Gamma holds." });
		assert.ok(bare.includes("Node id: c") && bare.includes("Explanation: none written yet"));
	});

	it("the node default body is the static text the code ships", () => {
		assert.ok(focusedNodeReviewInstructions({ nodeId: "c", nodeName: "G", nodeStatement: "G." }).startsWith(REVIEW_NODE_BODY));
	});

	it("the exercise in focus is appended after an override body, and survives an empty one", () => {
		setSwitches({ "office-hours": true });
		setOverride("office-hours", "MY OFFICE BODY");
		const text = officeHoursInstructions("Show the union is measurable.");
		assert.ok(text.startsWith("MY OFFICE BODY"));
		assert.ok(text.includes("<exercise>\nShow the union is measurable.\n</exercise>"));
		setOverride("office-hours", "");
		assert.ok(officeHoursInstructions("Show it.").includes("<exercise>\nShow it.\n</exercise>"));
	});

	it("the document and page block of the study assistant is appended after an override body", () => {
		const ctx = {
			chatId: "chat_1",
			chatStore: { getChat: () => ({ messages: [] }) },
			document: () => ({ id: "doc_1", title: "Notes", pageCount: 3 }),
			pageText: () => null,
			search: () => [],
		};
		setSwitches({ "study-assistant": true });
		setOverride("study-assistant", "MY STUDY BODY");
		const text = studyPrompt(ctx);
		assert.ok(text.startsWith("MY STUDY BODY"));
		assert.ok(text.includes("Document: Notes (3 pages)."));
	});
});
