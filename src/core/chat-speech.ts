// src/core/chat-speech.ts
/**
 * The text of an assistant message as it is read aloud (pure; no I/O).
 *
 * Only the text parts are read: tool calls and reasoning are not prose. In each text part the
 * markup that a voice would read as noise is removed, and the words are kept: fenced code blocks
 * (whole), node links (through stripNodeLinks, the same stripping as lecture audio), markdown
 * links (the label only), inline-code backticks, heading marks, table pipes and separator rows,
 * and emphasis marks. Whitespace is collapsed. The result is "" when nothing is speakable.
 */

import { stripNodeLinks } from "./ext/lecture/lecture.ts";

/** The part shape of an assistant message's content (pi TextContent, ThinkingContent, ToolCall). */
export interface SpeechPart {
	type: string;
	text?: unknown;
	[field: string]: unknown;
}

/** Fenced code blocks, line by line: a fence opens at a line starting with ``` or ~~~ and closes at the same marker. */
function dropFencedBlocks(text: string): string {
	const kept: string[] = [];
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const m = /^\s*(```|~~~)/.exec(line);
		if (fence === null) {
			if (m !== null) fence = m[1]!;
			else kept.push(line);
		} else if (m !== null && m[1] === fence) {
			fence = null;
		}
	}
	return kept.join("\n");
}

/** One text part, with the markup removed and the words kept. */
function speakableOf(text: string): string {
	let out = dropFencedBlocks(text);
	out = stripNodeLinks(out);
	out = out.replace(/\[([^\]\n]+)\]\([^()\s]+\)/g, "$1");
	out = out.replace(/`([^`\n]*)`/g, "$1");
	out = out
		.split("\n")
		.filter((line) => !/^[\s|:-]*-[\s|:-]*$/.test(line))
		.map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\|/g, " "))
		.join("\n");
	out = out.replace(/(^|[\s(])[*_]+(?=\S)/gm, "$1").replace(/(?<=\S)[*_]+(?=$|[\s).,;:!?])/gm, "");
	return out;
}

/** The speakable text of a message's parts: the text parts only, in order, joined by single spaces. */
export function speechText(parts: readonly SpeechPart[]): string {
	return parts
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => speakableOf(p.text as string))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}
