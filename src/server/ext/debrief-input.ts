// src/server/ext/debrief-input.ts
/**
 * @node ext/debrief/input
 * Request parsing for the debrief routes. Every failure is an HttpError 400
 * with a fixed message: the offending value is never echoed back.
 */

import { SESSION_KINDS, type ListFilter } from "../../core/ext/debrief/journal.ts";
import { HttpError } from "./http-error.ts";
import type { DebriefOutcome, LectureActivityInput } from "./debrief-service.ts";

export function parseListQuery(params: URLSearchParams): ListFilter {
	const out: ListFilter = {};
	const limit = params.get("limit");
	if (limit !== null) {
		const n = Number(limit);
		if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
		out.limit = n;
	}
	const kind = params.get("kind");
	if (kind !== null) {
		if (kind !== "weekly" && !SESSION_KINDS.includes(kind as never)) throw new HttpError(400, "unknown kind");
		out.kind = kind as ListFilter["kind"];
	}
	const since = params.get("since");
	if (since !== null) {
		if (Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO-8601 timestamp");
		out.since = since;
	}
	return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" && v.length <= 200 ? v : null);

export function parseLectureActivity(body: Record<string, unknown>): LectureActivityInput {
	const sessionId = str(body.sessionId);
	const lectureId = str(body.lectureId);
	if (sessionId === null || lectureId === null) throw new HttpError(400, "sessionId and lectureId are required");
	if (body.type === "lecture_view") {
		const slideId = str(body.slideId);
		if (slideId === null) throw new HttpError(400, "slideId is required");
		return { type: "lecture_view", sessionId, lectureId, slideId };
	}
	if (body.type === "concept_open") {
		const nodeId = str(body.nodeId);
		if (nodeId === null) throw new HttpError(400, "nodeId is required");
		return { type: "concept_open", sessionId, lectureId, nodeId };
	}
	if (body.type === "exercise_done") {
		const blockId = str(body.blockId);
		if (blockId === null) throw new HttpError(400, "blockId is required");
		return { type: "exercise_done", sessionId, lectureId, blockId };
	}
	throw new HttpError(400, "unknown activity type");
}

/** HTTP status and body for the result of ending a session. Nothing in a deferred outcome says why beyond a fixed word. */
export function outcomeResponse(out: DebriefOutcome): { status: number; body: Record<string, unknown> } {
	switch (out.status) {
		case "created": return { status: 201, body: { status: "created", entry: out.entry } };
		case "exists": return { status: 200, body: { status: "exists", entry: out.entry } };
		case "empty": return { status: 200, body: { status: "empty" } };
		case "deferred": return { status: 202, body: { status: "deferred", reason: out.reason } };
	}
}
