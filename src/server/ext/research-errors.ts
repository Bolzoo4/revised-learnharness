// src/server/ext/research-errors.ts
/**
 * An expected input mistake in the research loop's admin or service (400). The
 * message is a fixed phrase written for the learner; it never carries an
 * internal error text, so the route can send it as is.
 */

import { HttpError } from "./http-error.ts";

export class ResearchInputError extends HttpError {
	constructor(message: string) {
		super(400, message);
		this.name = "ResearchInputError";
	}
}
