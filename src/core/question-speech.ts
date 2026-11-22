// src/core/question-speech.ts
/**
 * The spoken form of a pending question (pure; no I/O, no clock).
 *
 * A pending `ask_user_question` or `quiz` tool part is turned into the text a voice reads aloud:
 * the question, then for option questions each option as "A: <label>.", then a closing prompt.
 * An `ask` option's description is read after its label. A quiz option is a bare claim, so a quiz
 * never reads anything but its label: the correct answer and the explanation are never spoken.
 *
 * The part is read through the same parsers the question dock uses, so a malformed question
 * speaks nothing (the dock shows its fallback). Options given as a JSON string are coerced first.
 */

import { guessLanguage } from "./ext/lecture/audio.ts";
import { parseOptionsIfString } from "./question-core.ts";
import { parseAskInput, parseQuizInput } from "./tool-parts.ts";

export interface SpokenOption {
	letter: string;
	label: string;
	value: string;
}

export interface SpokenForm {
	/** The text to synthesize. */
	text: string;
	language: "it" | "en";
	/** Empty for an open question. */
	options: SpokenOption[];
	/** Present (true) only for a multi-select question with options. */
	multi?: true;
}

type Language = SpokenForm["language"];

const CLOSING: Record<"open" | "option" | "multi", Record<Language, string>> = {
	open: { en: "Answer in your own words.", it: "Rispondi con parole tue." },
	option: { en: "Answer with the letter or the words.", it: "Rispondi con la lettera o con le parole." },
	multi: { en: "Answer with one or more letters.", it: "Rispondi con una o più lettere." },
};

/** One option as the speech needs it. Quiz options never carry a description. */
interface SpeechItem {
	label: string;
	value?: string;
	description?: string;
}

/** A label or description read as a sentence: a terminal mark is kept, otherwise a period is added. */
function sentence(text: string): string {
	return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Letters A..Z for the first 26 options; beyond that the position number, so every option is still read. */
function letterOf(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** The options' coerced copy of the raw input, so the existing parsers see an array. */
function withCoercedOptions(input: unknown): unknown {
	if (typeof input !== "object" || input === null || !("options" in input)) return input;
	const record = input as Record<string, unknown>;
	return { ...record, options: parseOptionsIfString(record.options as string | unknown[] | undefined) };
}

function build(question: string, items: SpeechItem[] | undefined, multiSelect: boolean): SpokenForm {
	const q = question.trim();
	const labels = (items ?? []).map((item) => item.label.trim());
	const detected = guessLanguage([q, ...labels].join(" "));
	const language: Language = detected === "it" ? "it" : "en";

	if (items === undefined || items.length === 0) {
		return { text: `${q} ${CLOSING.open[language]}`, language, options: [] };
	}

	const options: SpokenOption[] = items.map((item, index) => ({
		letter: letterOf(index),
		label: item.label.trim(),
		value: (item.value ?? item.label).trim(),
	}));
	const lines = items.map((item, index) => {
		const description = item.description?.trim();
		const line = `${options[index]!.letter}: ${sentence(options[index]!.label)}`;
		return description ? `${line} ${sentence(description)}` : line;
	});
	const closing = multiSelect ? CLOSING.multi[language] : CLOSING.option[language];
	const text = [q, ...lines, closing].join(" ");
	return multiSelect ? { text, language, options, multi: true } : { text, language, options };
}

/**
 * The spoken form of a pending question part, or null when the part is not a pending
 * `ask_user_question` or `quiz` (or `probe`, the quiz's probe-phase name) with a valid input.
 */
export function spokenForm(part: unknown): SpokenForm | null {
	if (typeof part !== "object" || part === null) return null;
	const { type, state, input } = part as { type?: unknown; state?: unknown; input?: unknown };
	if (state !== "input-available" || typeof type !== "string" || !type.startsWith("tool-")) return null;
	const tool = type.slice("tool-".length);

	if (tool === "ask_user_question") {
		const parsed = parseAskInput(withCoercedOptions(input));
		if (!parsed) return null;
		const items = parsed.options?.map((o) => ({ label: o.label, value: o.value, description: o.description }));
		return build(parsed.question, items, parsed.multiSelect === true);
	}

	if (tool === "quiz" || tool === "probe") {
		const parsed = parseQuizInput(withCoercedOptions(input));
		if (!parsed) return null;
		// Bare claims only: label and value, never a description, correctAnswer or explanation.
		const items = parsed.options.map((o) => ({ label: o.label, value: o.value }));
		return build(parsed.question, items, parsed.multiSelect === true);
	}

	return null;
}
