// The "copy attachments" setting: default ON, kept through the strict write parser and the lenient read side.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { composeCopyAttachments } from "../components/settings/agent-section.tsx";

describe("copyAttachments", () => {
	it("the write parser keeps a boolean and refuses anything else", () => {
		assert.deepEqual(parseAgentSettingsBody({ copyAttachments: false }), { ok: true, settings: { copyAttachments: false } });
		assert.deepEqual(parseAgentSettingsBody({ copyAttachments: true }), { ok: true, settings: { copyAttachments: true } });
		const bad = parseAgentSettingsBody({ copyAttachments: "no" });
		assert.equal(bad.ok, false);
	});
	it("the read side keeps a saved boolean and ignores a malformed value (the default ON resumes)", () => {
		assert.equal(sanitizeUserSettings({ version: 1, agent: { copyAttachments: false } })?.agent?.copyAttachments, false);
		assert.equal(sanitizeUserSettings({ version: 1, agent: { copyAttachments: "x" } })?.agent?.copyAttachments, undefined);
	});
	it("the UI switch changes only that key", () => {
		const agent = { tools: { pdf: false }, fileAccess: { restricted: true, folders: ["~/Study"] } };
		assert.deepEqual(composeCopyAttachments(agent, false), { ...agent, copyAttachments: false });
	});
});
