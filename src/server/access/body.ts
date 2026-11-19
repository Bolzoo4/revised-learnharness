// src/server/access/body.ts
/** Read at most `limit` bytes of the body; null when it is longer (the rest is never buffered). */
export async function readCapped(request: Request, limit: number): Promise<string | null> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) { await reader.cancel(); return null; }
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
