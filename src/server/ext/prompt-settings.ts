// src/server/ext/prompt-settings.ts
/**
 * The settings service for the extension's editable prompts (behind
 * app/api/ext/prompts). Every id is checked against the catalog before any
 * file is touched; every error is a fixed message (HttpError), never an echo
 * of the input. Semantics mirror upstream's prompt overrides: a version is in
 * use only while its switch is on and its file exists; reset removes the file
 * and clears the switch.
 */

import { extPromptDefault } from "../../agent/ext/prompt-defaults.ts";
import {
	EXT_PROMPT_CATALOG,
	EXT_PROMPT_MAX_TEXT_CHARS,
	extPromptEntry,
	isExtPromptId,
	type ExtPromptId,
	type ExtPromptView,
} from "../../core/ext/prompt-catalog.ts";
import {
	deleteExtPromptOverride,
	readExtPromptOverride,
	readExtPromptSwitches,
	setExtPromptSwitch,
	writeExtPromptOverride,
} from "../../store/ext/prompt-store.ts";
import { HttpError } from "./http-error.ts";

const UNKNOWN_PROMPT = "unknown extension prompt";
const BAD_BODY = "the body must be {text?: string, enabled?: boolean}";
const TEXT_TOO_LONG = `the text is longer than ${EXT_PROMPT_MAX_TEXT_CHARS} characters`;
const NEEDS_TEXT = "write a version of the prompt before turning it on";

/** The write body: text and/or enabled. Anything else is a 400. */
export interface ExtPromptWrite {
	text?: string;
	enabled?: boolean;
}

/** The catalog id from a route parameter, or a 404. */
function requireId(rawId: string): ExtPromptId {
	if (!isExtPromptId(rawId)) throw new HttpError(404, UNKNOWN_PROMPT);
	return rawId;
}

/** One prompt's view; `switches` is read once by the caller. */
function viewOf(id: ExtPromptId, switches: Partial<Record<ExtPromptId, true>>): ExtPromptView {
	const entry = extPromptEntry(id);
	if (entry === undefined) throw new HttpError(404, UNKNOWN_PROMPT);
	const overrideText = readExtPromptOverride(id);
	return {
		id,
		label: entry.label,
		description: entry.description,
		warning: entry.warning,
		defaultText: extPromptDefault(id),
		overrideText,
		enabled: overrideText !== null && switches[id] === true,
	};
}

/** Every editable prompt, in catalog order. */
export function listExtPrompts(): ExtPromptView[] {
	const switches = readExtPromptSwitches();
	return EXT_PROMPT_CATALOG.map((entry) => viewOf(entry.id, switches));
}

/** Validate a write body: exactly the known keys, with the right types, and the text length bound. */
export function parseExtPromptWrite(body: Record<string, unknown>): ExtPromptWrite {
	const keys = Object.keys(body);
	if (keys.length === 0 || keys.some((key) => key !== "text" && key !== "enabled")) throw new HttpError(400, BAD_BODY);
	const { text, enabled } = body;
	if (text !== undefined && typeof text !== "string") throw new HttpError(400, BAD_BODY);
	if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, BAD_BODY);
	if (typeof text === "string" && text.length > EXT_PROMPT_MAX_TEXT_CHARS) throw new HttpError(400, TEXT_TOO_LONG);
	return { ...(text !== undefined ? { text } : {}), ...(enabled !== undefined ? { enabled } : {}) };
}

/**
 * Save the text and/or the switch. Checks run before any write: turning a
 * switch on needs a file to be in use, which a text in the same request
 * provides. The file is written before the switch, so a crash between the
 * two leaves "off + file", a valid state.
 */
export function updateExtPrompt(rawId: string, body: Record<string, unknown>): ExtPromptView {
	const id = requireId(rawId);
	const { text, enabled } = parseExtPromptWrite(body);
	const hasFile = text !== undefined || readExtPromptOverride(id) !== null;
	if (enabled === true && !hasFile) throw new HttpError(400, NEEDS_TEXT);
	if (text !== undefined) writeExtPromptOverride(id, text);
	if (enabled !== undefined) setExtPromptSwitch(id, enabled);
	return viewOf(id, readExtPromptSwitches());
}

/** Remove the override file and clear its switch (the switch goes first: a crash between leaves "off + file"). */
export function resetExtPrompt(rawId: string): { id: ExtPromptId; deleted: true; switchCleared: boolean } {
	const id = requireId(rawId);
	const switchCleared = readExtPromptSwitches()[id] === true;
	if (switchCleared) setExtPromptSwitch(id, false);
	deleteExtPromptOverride(id);
	return { id, deleted: true, switchCleared };
}
