// components/ext/lecture-leftovers-client.ts
/**
 * The browser's side of removing a chapter's leftovers: POST /api/ext/lectures/[id]/purge with the chapter
 * index. Returns null when the removal is done, else the text to show. The server's refusals are fixed texts.
 */

export const LEFTOVERS_REJECTED = "Could not remove them. Try again in a moment.";

export async function removeLeftovers(bookId: string, chapterIndex: number): Promise<string | null> {
	try {
		const res = await fetch(`/api/ext/lectures/${encodeURIComponent(bookId)}/purge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chapterIndex }),
		});
		if (res.ok) return null;
		const body = (await res.json().catch(() => ({}))) as { error?: unknown };
		return typeof body.error === "string" ? body.error : LEFTOVERS_REJECTED;
	} catch {
		return LEFTOVERS_REJECTED;
	}
}
