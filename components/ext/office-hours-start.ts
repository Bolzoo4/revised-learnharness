// components/ext/office-hours-start.ts
/**
 * Opens office hours from a lecture's exercise (POST /api/ext/lectures/[id]/office-hours). Pure over an
 * injected fetch, so the request and its refusals are tested without a DOM.
 */

export const START_FAILED = "Could not open office hours for this exercise. Try again.";

export type OfficeHoursStart = { chatId: string } | { error: string };

/** The server's refusals carry fixed messages; anything else (or a network failure) gets the generic text. */
export async function startOfficeHours(fetchFn: typeof fetch, lectureId: string, blockId: string): Promise<OfficeHoursStart> {
	try {
		const res = await fetchFn(`/api/ext/lectures/${encodeURIComponent(lectureId)}/office-hours`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ blockId }),
		});
		const body = (await res.json().catch(() => ({}))) as { chatId?: unknown; error?: unknown };
		if (!res.ok) return { error: typeof body.error === "string" && body.error !== "" ? body.error : START_FAILED };
		if (typeof body.chatId !== "string" || body.chatId === "") return { error: START_FAILED };
		return { chatId: body.chatId };
	} catch {
		return { error: START_FAILED };
	}
}
