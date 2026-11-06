// src/store/ext/prompt-store.ts
/**
 * The file store behind the settings' extension prompts (docs/ext/CONTRACTS.md,
 * "Editable extension prompts"):
 *
 *   override text : <PROMPTS_OVERRIDE_DIR>/ext/<id>.md
 *   switches      : <data>/ext/prompt-switches.json  ({"<id>": true})
 *
 * Only ids in the catalog reach a path: every entry point checks isExtPromptId
 * before a path is built, so no path comes from input. Every write is atomic
 * (write a temp file, then rename), and the switches file is rewritten whole.
 */

import fs from "node:fs";
import path from "node:path";
import { PROMPTS_OVERRIDE_DIR } from "../../../config.ts";
import { isExtPromptId, type ExtPromptId } from "../../core/ext/prompt-catalog.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../atomic-write.ts";
import { EXT_PATHS } from "./paths.ts";

const OVERRIDE_DIR = path.join(PROMPTS_OVERRIDE_DIR, "ext");

/** The override file for a catalog id. Throws for anything else (no path from input). */
function overrideFileFor(id: ExtPromptId): string {
	if (!isExtPromptId(id)) throw new Error("not an extension prompt id");
	return path.join(OVERRIDE_DIR, `${id}.md`);
}

/** The override text, or null when there is no file. */
export function readExtPromptOverride(id: ExtPromptId): string | null {
	try {
		return fs.readFileSync(overrideFileFor(id), "utf-8");
	} catch {
		return null;
	}
}

/** Replace the override text (creates the directory on first write). */
export function writeExtPromptOverride(id: ExtPromptId, text: string): void {
	const file = overrideFileFor(id);
	fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
	writeFileAtomicSync(file, text, { allowInPlaceFallback: true });
}

/** Remove the override file (idempotent). */
export function deleteExtPromptOverride(id: ExtPromptId): void {
	const file = overrideFileFor(id);
	try {
		fs.unlinkSync(file);
	} catch {
		// absent already = done
	}
	removeLeftoverTemps(file);
}

/** The switches that are on. A missing or unreadable file means every switch is off. */
export function readExtPromptSwitches(): Partial<Record<ExtPromptId, true>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(EXT_PATHS.promptSwitches, "utf-8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const out: Partial<Record<ExtPromptId, true>> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (isExtPromptId(key) && value === true) out[key] = true;
	}
	return out;
}

/** Turn one switch on or off; the other switches are kept. */
export function setExtPromptSwitch(id: ExtPromptId, on: boolean): void {
	if (!isExtPromptId(id)) throw new Error("not an extension prompt id");
	const switches = readExtPromptSwitches();
	if (on) switches[id] = true;
	else delete switches[id];
	fs.mkdirSync(EXT_PATHS.dir, { recursive: true });
	writeFileAtomicSync(EXT_PATHS.promptSwitches, JSON.stringify(switches, null, "\t") + "\n", { allowInPlaceFallback: true });
}
