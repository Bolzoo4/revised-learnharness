// tests/ext-research-view.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
	cycleControls,
	GOAL_MAX_CHARS,
	pauseText,
	reportsNewestFirst,
	ResearchView,
	statusText,
} from "../components/ext/research-view.tsx";

/** The page as first painted (no status loaded yet), parsed so the assertions read the real markup. */
function render(): Document {
	return parseHTML(`<html><body>${renderToStaticMarkup(<ResearchView />)}</body></html>`).document as unknown as Document;
}
const button = (doc: Document, text: string) => [...doc.querySelectorAll("button")].find((b) => b.textContent === text);
const labelTexts = (doc: Document) => [...doc.querySelectorAll("label")].map((l) => l.textContent ?? "");
const idleStatus = { running: false, steers: [], reports: [], lastCycle: null };
const runningStatus = { running: true, trigger: "schedule" as const, startedAt: "2026-11-05T10:00:00.000Z", steers: [], reports: [], lastCycle: null };

it("the intro paragraph says what a cycle does and that nothing enters the library unapproved", () => {
	const text = render().querySelector("p")?.textContent ?? "";
	assert.ok(text.includes("looks for new sources related to your goals"), text);
	assert.ok(text.includes("never adds anything to your library without your approval"), text);
	assert.ok(text.includes("model subscription"), text);
});

it("sections come in the order Status, Research goal, Inbox, Marks, Watchlist, Recent cycles", () => {
	const doc = render();
	const sections = [...doc.querySelectorAll("section, details")];
	assert.deepEqual(
		sections.map((s) => s.querySelector("h2")?.textContent),
		["Status", "Research goal", "Inbox (pending)", "Marks", "Watchlist", "Recent cycles"],
	);
});

it("Watchlist and Recent cycles are collapsed by default", () => {
	const doc = render();
	const details = [...doc.querySelectorAll("details")];
	assert.deepEqual(details.map((d) => d.querySelector("h2")?.textContent), ["Watchlist", "Recent cycles"]);
	for (const d of details) assert.equal(d.hasAttribute("open"), false, `${d.querySelector("h2")?.textContent} starts closed`);
});

it("every section has a heading and a one-line plain description", () => {
	const doc = render();
	for (const s of [...doc.querySelectorAll("section, details")]) {
		assert.ok(s.className.includes("rounded") && s.className.includes("border") && s.className.includes("p-4"), "sections are visually separated");
		assert.ok((s.querySelector("p.text-muted-foreground")?.textContent ?? "").length > 20, `${s.querySelector("h2")?.textContent} has a description`);
	}
});

it("the goal field has a visible label, a placeholder example and the 500 character limit", () => {
	const doc = render();
	assert.ok(labelTexts(doc).some((l) => l.includes("Research goal")), "a visible label reads Research goal");
	const markup = renderToStaticMarkup(<ResearchView />);
	assert.equal(GOAL_MAX_CHARS, 500);
	assert.ok(new RegExp("maxlength=\"500\"", "i").test(markup), "the goal input stops at 500 characters");
	assert.ok(markup.includes("Investigate the state of the art of plastic materials"), "the placeholder gives an example goal");
});

it("the goal Start button is disabled until a goal is typed; Run a cycle now stays for gap-driven cycles", () => {
	const doc = render();
	assert.equal(button(doc, "Start")?.hasAttribute("disabled"), true);
	assert.equal(button(doc, "Run a cycle now") !== undefined, true, "the gap-driven action keeps its name");
	assert.ok(doc.body.textContent?.includes("Run a cycle now") && doc.body.textContent?.includes("gap"), "the gap-driven difference is described");
});

it("the note form replaces the steer form and says when the agent reads it", () => {
	const doc = render();
	const labels = labelTexts(doc);
	assert.ok(labels.some((l) => l.includes("Leave a note for the agent")), "a visible label reads Leave a note for the agent");
	assert.equal(labels.some((l) => l.includes("Steer")), false, "no steer wording on the page");
	assert.equal(button(doc, "Send steer"), undefined);
	assert.equal(button(doc, "Send note")?.hasAttribute("disabled"), true);
	assert.ok(doc.body.textContent?.includes("The agent reads your note after its next report."));
	assert.equal(doc.body.textContent?.toLowerCase().includes("steer"), false, "steer is not visible anywhere");
});

it("with no cycle running, abort and notes are disabled and the note says why", () => {
	const doc = render();
	assert.equal(button(doc, "Abort")?.hasAttribute("disabled"), true, "Abort is disabled while idle");
	assert.ok(doc.body.textContent?.includes("A note can be left only while a cycle is running."));
	assert.ok(doc.body.textContent?.includes("talk to the research agent"), "the chat button is described");
});

it("the marks section lists marks with a Clear control, no typed-id form, and the one-line hint", () => {
	const doc = render();
	const section = [...doc.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Marks");
	assert.ok(section, "the Marks section exists");
	assert.ok((section?.textContent ?? "").toLowerCase().includes("set marks from a node in the graph"));
	assert.equal(button(doc, "Add mark"), undefined, "the typed-id mark form is gone");
	assert.equal(labelTexts(doc).some((l) => l.includes("Node id / goal id") || l.includes("Mark target kind")), false);
	assert.equal(doc.querySelector('select[aria-label="Change mark"]'), null, "marks cannot be changed here");
});

it("the remaining form rows have visible labels, not placeholders only", () => {
	const labels = labelTexts(render());
	for (const text of ["Watch type", "Query or feed URL"]) {
		assert.ok(labels.some((l) => l.includes(text)), `a visible label reads "${text}"`);
	}
});

it("empty states say what to do next", () => {
	const text = render().body.textContent ?? "";
	assert.ok(text.includes("Nothing waiting. Run a cycle or add a watch entry."));
	assert.ok(text.includes("No cycles yet."));
});

it("cycleControls: abort and notes need a running cycle; a start is refused while one runs", () => {
	const idle = cycleControls(idleStatus);
	assert.equal(idle.abortDisabled, true);
	assert.equal(idle.noteDisabled, true);
	assert.equal(idle.startDisabled, false);
	assert.ok(idle.noteHint?.includes("only while a cycle is running"));
	const running = cycleControls(runningStatus);
	assert.equal(running.abortDisabled, false);
	assert.equal(running.noteDisabled, false);
	assert.equal(running.startDisabled, true);
	assert.equal(running.noteHint, null);
	assert.equal(cycleControls(null).abortDisabled, true, "before the first load nothing can be aborted");
});

it("reportsNewestFirst puts the latest report on top and is empty without reports", () => {
	assert.deepEqual(reportsNewestFirst({ ...runningStatus, reports: ["first", "second", "third"] }), ["third", "second", "first"]);
	assert.deepEqual(reportsNewestFirst(null), []);
	assert.deepEqual(reportsNewestFirst(idleStatus), []);
});

it("statusText: Loading, Idle, or Running with who started it", () => {
	assert.equal(statusText(null), "Loading");
	assert.equal(statusText(idleStatus), "Idle");
	assert.ok(statusText(runningStatus).startsWith("Running (scheduled, since "));
	assert.ok(statusText({ ...runningStatus, trigger: "manual" }).startsWith("Running (started by you"));
});

it("pauseText names the provider usage limit and the time it ends, and is absent otherwise", () => {
	assert.equal(pauseText(idleStatus), null);
	const text = pauseText({ ...idleStatus, providerPausedUntil: "2026-11-05T12:30:00.000Z" });
	assert.ok(text?.startsWith("Paused: provider usage limit until "), text ?? "");
});
