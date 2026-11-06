// tests/ext-research-view.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { cycleControls, pauseText, ResearchView, statusText } from "../components/ext/research-view.tsx";

/** The page as first painted (no status loaded yet), parsed so the assertions read the real markup. */
function render(): Document {
	return parseHTML(`<html><body>${renderToStaticMarkup(<ResearchView />)}</body></html>`).document as unknown as Document;
}
const button = (doc: Document, text: string) => [...doc.querySelectorAll("button")].find((b) => b.textContent === text);
const labelTexts = (doc: Document) => [...doc.querySelectorAll("label")].map((l) => l.textContent ?? "");
const idleStatus = { running: false, steers: [], lastCycle: null };
const runningStatus = { running: true, trigger: "schedule" as const, startedAt: "2026-11-05T10:00:00.000Z", steers: [], lastCycle: null };

it("the intro paragraph says what a cycle does and that nothing enters the library unapproved", () => {
	const text = render().querySelector("p")?.textContent ?? "";
	assert.ok(text.includes("looks for new sources related to your goals"), text);
	assert.ok(text.includes("never adds anything to your library without your approval"), text);
	assert.ok(text.includes("model subscription"), text);
});

it("every section has a heading and a one-line plain description", () => {
	const doc = render();
	const sections = [...doc.querySelectorAll("section")];
	assert.deepEqual(
		sections.map((s) => s.querySelector("h2")?.textContent),
		["Status", "Inbox (pending)", "Marks", "Watchlist", "Recent cycles"],
	);
	for (const s of sections) {
		assert.ok(s.className.includes("rounded") && s.className.includes("border") && s.className.includes("p-4"), "sections are visually separated");
		assert.ok((s.querySelector("p.text-muted-foreground")?.textContent ?? "").length > 20, `${s.querySelector("h2")?.textContent} has a description`);
	}
});

it("form rows have visible labels, not placeholders only", () => {
	const labels = labelTexts(render());
	for (const text of ["Steer the running cycle", "Mark target kind", "Node id / goal id", "Action", "Watch type", "Query or feed URL"]) {
		assert.ok(labels.some((l) => l.includes(text)), `a visible label reads "${text}"`);
	}
});

it("with no cycle running, abort and steering are disabled and steering says why", () => {
	const doc = render();
	assert.equal(button(doc, "Abort")?.hasAttribute("disabled"), true, "Abort is disabled while idle");
	assert.equal(button(doc, "Send steer")?.hasAttribute("disabled"), true);
	assert.ok(doc.body.textContent?.includes("Steering works only while a cycle is running."));
	assert.equal(button(doc, "Run a cycle now") !== undefined, true, "the primary action is named for what it does");
	assert.ok(doc.body.textContent?.includes("talk to the research agent"), "the chat button is described");
});

it("empty states say what to do next", () => {
	const text = render().body.textContent ?? "";
	assert.ok(text.includes("Nothing waiting. Run a cycle or add a watch entry."));
	assert.ok(text.includes("No cycles yet."));
});

it("cycleControls: abort and steer need a running cycle; a start is refused while one runs", () => {
	const idle = cycleControls(idleStatus);
	assert.equal(idle.abortDisabled, true);
	assert.equal(idle.steerDisabled, true);
	assert.equal(idle.startDisabled, false);
	assert.ok(idle.steerHint?.includes("only while a cycle is running"));
	const running = cycleControls(runningStatus);
	assert.equal(running.abortDisabled, false);
	assert.equal(running.steerDisabled, false);
	assert.equal(running.startDisabled, true);
	assert.equal(running.steerHint, null);
	assert.equal(cycleControls(null).abortDisabled, true, "before the first load nothing can be aborted");
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
