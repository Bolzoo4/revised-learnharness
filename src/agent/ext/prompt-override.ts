// src/agent/ext/prompt-override.ts
/**
 * The agent-side reader of the extension's prompt overrides (the twin of
 * src/agent/prompt-segments.ts for upstream's prompts). The agent layer may
 * not import the store, so this reads the two config-anchored locations
 * directly; the store (src/store/ext/prompt-store.ts) writes the same files.
 *
 *   override text : <PROMPTS_OVERRIDE_DIR>/ext/<id>.md
 *   switches      : <data>/ext/prompt-switches.json  ({"<id>": true, ...})
 *
 * The switches live in their own file on purpose: upstream's settings.json
 * drops keys it does not know. An override is in use only when its switch is
 * true AND its file is readable. An enabled empty file is an override that
 * contributes no text (it does not fall back to the default), matching
 * upstream. Both are read on every call, so each new agent construction sees
 * the current text.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../../config.ts";
import { isExtPromptId } from "../../core/ext/prompt-catalog.ts";

/** The override file for one id (the id is validated by the caller). */
function overrideFileFor(id: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, "ext", `${id}.md`);
}

/** The switch file. Same path as the store's EXT_PATHS.promptSwitches (the layers may not import each other). */
function switchFile(): string {
	return path.join(PATHS.data, "ext", "prompt-switches.json");
}

/** The switch map; anything unreadable or malformed is all switches off. */
function readSwitches(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(switchFile(), "utf-8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The override text for one id, or null when the file cannot be read. */
function readOverride(id: string): string | null {
	try {
		return fs.readFileSync(overrideFileFor(id), "utf-8");
	} catch {
		return null;
	}
}

/**
 * The text an agent runs with for one editable prompt: the user's version
 * when its switch is on and its file is readable, otherwise `defaultText`.
 * An id outside the catalog always gets `defaultText`.
 */
export function resolveExtPrompt(id: string, defaultText: string): string {
	if (!isExtPromptId(id)) return defaultText;
	if (readSwitches()[id] !== true) return defaultText;
	return readOverride(id) ?? defaultText;
}
