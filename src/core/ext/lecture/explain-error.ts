// src/core/ext/lecture/explain-error.ts
/**
 * The chapter error as a learner reads it (pure). The stored state values are
 * unchanged; only the text is explained: repeated `;`-separated parts are shown
 * once with a count, and a stop before the submit tool gets one plain hint.
 */

/** The plain hint for a model that ran out of output before calling its submit tool. */
export const NO_SUBMIT_HINT =
	"The model stopped before calling the tool. This usually means it ran out of output space: lower the thinking level or choose a model with a larger output limit in Settings.";

const NO_SUBMIT_PATTERN = /never submitted|ended without calling/i;

export function explainChapterError(message: string): string {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const raw of message.split(";")) {
		const part = raw.trim();
		if (part === "") continue;
		if (!counts.has(part)) order.push(part);
		counts.set(part, (counts.get(part) ?? 0) + 1);
	}
	const body = order.map((part) => (counts.get(part)! > 1 ? `${part} (x${counts.get(part)})` : part)).join("; ");
	if (!NO_SUBMIT_PATTERN.test(message)) return body;
	if (body === "") return NO_SUBMIT_HINT;
	return `${body.replace(/\.+$/, "")}. ${NO_SUBMIT_HINT}`;
}
