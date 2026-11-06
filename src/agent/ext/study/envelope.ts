// src/agent/ext/study/envelope.ts
/**
 * Text that comes from the learner's document (page text, selections, titles,
 * known statements) is DATA. It is placed inside a prompt envelope, so it must
 * not be able to close the envelope, open a new one, or start a markdown
 * heading. The neutralising replaces the envelope's own characters inside the
 * data with visually similar ones; the words stay readable to the model.
 */

import { flattenText } from "../../../core/ext/study/bounds.ts";

/** Envelope markers: three angle brackets, a closing tag, a run of three backticks. */
const ENVELOPE_SEQUENCE = /<{3}|>{3}|<\/|`{3}/g;

/** Multi-line data: envelope markers and line-start headings are made inert; line breaks are kept. */
export function untrustedText(text: string): string {
	return text.replace(ENVELOPE_SEQUENCE, (m) => m.replace(/</g, "‹").replace(/>/g, "›").replace(/`/g, "ˋ")).replace(/^(\s{0,3})#/gm, "$1＃");
}

/** Single-line data (a title, a statement): flattened to one bounded line, then neutralised. */
export function untrustedLine(text: string, maxChars: number): string {
	return untrustedText(flattenText(text, maxChars));
}
