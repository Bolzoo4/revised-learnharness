// components/ext/lecture-retry-client.ts
/**
 * The browser's side of the lecture retry: POST /api/ext/lectures/[id]/retry with the chapter index
 * (or none, for every chapter that needs it). Returns null when the retry started, else the text to show.
 * The server's refusals are fixed texts, so they are shown as they come.
 */

export const RETRY_REJECTED = "Could not start the retry. Try again in a moment.";

export async function startLectureRetry(bookId: string, chapterIndex?: number): Promise<string | null> {
	try {
		const res = await fetch(`/api/ext/lectures/${encodeURIComponent(bookId)}/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(chapterIndex === undefined ? {} : { chapterIndex }),
		});
		if (res.ok) return null;
		const body = (await res.json().catch(() => ({}))) as { error?: unknown };
		return typeof body.error === "string" ? body.error : RETRY_REJECTED;
	} catch {
		return RETRY_REJECTED;
	}
}
