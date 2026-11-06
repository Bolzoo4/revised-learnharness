// src/server/ext/study-input.ts
/** Request-body parsing for the study routes. Anything malformed is a 400 StudyError. */

import { StudyError } from "./study-service.ts";

export function requireString(body: Record<string, unknown>, field: string): string {
	const v = body[field];
	if (typeof v !== "string" || v.trim() === "") throw new StudyError(400, `${field} is required`);
	return v;
}

export interface Decision {
	approve: Array<{ draftId: string; proposition?: unknown; question?: unknown; answer?: unknown; pin?: unknown }>;
	reject: string[];
}

/** { approve?: [{draftId, proposition?, question?, answer?, pin?}], reject?: [draftId] } */
export function parseDecision(body: Record<string, unknown>): Decision {
	const approveRaw = body.approve ?? [];
	const rejectRaw = body.reject ?? [];
	if (!Array.isArray(approveRaw) || !Array.isArray(rejectRaw)) throw new StudyError(400, "approve and reject must be lists");
	if (approveRaw.length + rejectRaw.length > 200) throw new StudyError(400, "too many drafts in one request");
	const approve = approveRaw.map((item) => {
		if (typeof item !== "object" || item === null || typeof (item as { draftId?: unknown }).draftId !== "string") {
			throw new StudyError(400, "every approved draft needs a draftId");
		}
		const r = item as Record<string, unknown>;
		return { draftId: r.draftId as string, proposition: r.proposition, question: r.question, answer: r.answer, pin: r.pin };
	});
	const reject = rejectRaw.map((id) => {
		if (typeof id !== "string") throw new StudyError(400, "rejected drafts are listed by draftId");
		return id;
	});
	return { approve, reject };
}
