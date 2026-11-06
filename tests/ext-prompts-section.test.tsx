/**
 * The "Extension agents" section (components/ext/prompts-section.tsx) and its
 * mount in the Agent settings. SSR: effects do not run, so the rendered state
 * is the loading state; the row states are rendered from props.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtPromptRow, ExtPromptsSection, promptEditorState, promptUseHint } from "../components/ext/prompts-section.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import type { ExtPromptView } from "../src/core/index.ts";

/** True when the element's own disabled attribute is set (not a `disabled:` class variant). */
function isDisabled(tag: string): boolean {
	return /\sdisabled=""/.test(tag);
}

function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `no ${testid}`);
	const start = html.lastIndexOf("<", i);
	return html.slice(start, html.indexOf(">", i) + 1);
}

const base: ExtPromptView = {
	id: "verifier",
	label: "Verifier",
	description: "Finds passages that support or contradict a statement.",
	warning: "The final JSON block must keep its shape.",
	defaultText: "DEFAULT TEXT",
	overrideText: null,
	enabled: false,
};

describe("ExtPromptsSection", () => {
	it("renders the group under the title Extension agents, in its loading state under SSR", () => {
		const html = renderToStaticMarkup(<ExtPromptsSection />);
		assert.ok(html.includes('data-testid="group-ext-prompts"'));
		assert.ok(html.includes("Extension agents"));
		assert.ok(html.includes("Loading extension agents"));
	});

	it("is mounted in the Agent settings right after the System prompts group", () => {
		const html = renderToStaticMarkup(
			<AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} />,
		);
		const prompts = html.indexOf('data-testid="group-prompts"');
		const ext = html.indexOf('data-testid="group-ext-prompts"');
		assert.ok(prompts >= 0 && ext > prompts, "extension group after the upstream prompts group");
	});
});

describe("ExtPromptRow", () => {
	it("with no version file: the switch is locked off, Reset and Save are inert, the default is one click away", () => {
		const html = renderToStaticMarkup(<ExtPromptRow prompt={base} onChanged={() => {}} />);
		const toggle = tagOf(html, "toggle-ext-prompt-verifier");
		assert.ok(toggle.includes('aria-checked="false"'));
		assert.ok(isDisabled(toggle));
		assert.ok(html.includes("Show default text"));
		assert.ok(html.includes(base.warning), "the warning is shown");
		assert.ok(!html.includes("Your version is in use"));
		assert.ok(!html.includes("Your version is saved"));
		assert.ok(html.includes('aria-label="Your version of Verifier"'));
		assert.ok(isDisabled(tagOf(html, "ext-prompt-reset-verifier")));
		assert.ok(isDisabled(tagOf(html, "ext-prompt-save-verifier")));
	});

	it("with a version in use: the switch is on, Reset is live, and the hint says the version is in use", () => {
		const html = renderToStaticMarkup(<ExtPromptRow prompt={{ ...base, overrideText: "MINE", enabled: true }} onChanged={() => {}} />);
		const toggle = tagOf(html, "toggle-ext-prompt-verifier");
		assert.ok(toggle.includes('aria-checked="true"'));
		assert.ok(!isDisabled(toggle));
		assert.ok(!isDisabled(tagOf(html, "ext-prompt-reset-verifier")));
		assert.ok(html.includes("Your version is in use"));
	});

	it("with a saved version that is switched off: the hint says so", () => {
		const html = renderToStaticMarkup(<ExtPromptRow prompt={{ ...base, overrideText: "MINE", enabled: false }} onChanged={() => {}} />);
		assert.ok(html.includes("Your version is saved but not in use"));
		assert.ok(!html.includes("Your version is in use"));
	});

	it("the editor opens on the saved version when there is one, else on the default", () => {
		const saved = renderToStaticMarkup(<ExtPromptRow prompt={{ ...base, overrideText: "MINE", enabled: true }} onChanged={() => {}} />);
		assert.ok(saved.includes(">MINE</textarea>"));
		const fresh = renderToStaticMarkup(<ExtPromptRow prompt={base} onChanged={() => {}} />);
		assert.ok(fresh.includes(">DEFAULT TEXT</textarea>"));
	});
});

describe("promptEditorState and promptUseHint", () => {
	it("shows the saved text, and Save has something to save only when the draft differs from it", () => {
		assert.deepEqual(promptEditorState(base, null), { shown: "DEFAULT TEXT", dirty: false, hasFile: false });
		assert.deepEqual(promptEditorState({ ...base, overrideText: "MINE" }, null), { shown: "MINE", dirty: false, hasFile: true });
		assert.deepEqual(promptEditorState(base, "EDITED"), { shown: "EDITED", dirty: true, hasFile: false });
		assert.deepEqual(promptEditorState({ ...base, overrideText: "MINE" }, "MINE"), { shown: "MINE", dirty: false, hasFile: true });
		assert.deepEqual(promptEditorState({ ...base, overrideText: "MINE" }, ""), { shown: "", dirty: true, hasFile: true });
	});

	it("names the version in use only when there is one and its switch is on", () => {
		assert.equal(promptUseHint(base), undefined);
		assert.equal(promptUseHint({ ...base, overrideText: "M", enabled: true }), "Your version is in use");
		assert.equal(promptUseHint({ ...base, overrideText: "M", enabled: false }), "Your version is saved but not in use");
	});
});
