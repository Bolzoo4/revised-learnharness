// src/core/ext/lecture/retry.ts
/**
 * generate -> validate -> retry with feedback (REQ-lec-07): at most
 * `maxRetries` retries after the first attempt (so maxRetries + 1 attempts).
 * Errors thrown by `attempt` are not retried: they propagate (aborts, missing models).
 */

export type RetryOutcome<T> =
	| { ok: true; value: T; attempts: number }
	| { ok: false; value: T; errors: string[]; attempts: number };

export async function generateWithFeedback<T>(opts: {
	attempt: (feedback: string | null) => Promise<T>;
	/** Rule violations; empty = accepted. */
	validate: (value: T) => string[];
	/** Turns violations into the feedback text for the next attempt. */
	feedback: (errors: string[]) => string;
	maxRetries: number;
}): Promise<RetryOutcome<T>> {
	let feedback: string | null = null;
	let value!: T;
	let errors: string[] = [];
	for (let attempts = 1; attempts <= opts.maxRetries + 1; attempts++) {
		value = await opts.attempt(feedback);
		errors = opts.validate(value);
		if (errors.length === 0) return { ok: true, value, attempts };
		feedback = opts.feedback(errors);
	}
	return { ok: false, value, errors, attempts: opts.maxRetries + 1 };
}
