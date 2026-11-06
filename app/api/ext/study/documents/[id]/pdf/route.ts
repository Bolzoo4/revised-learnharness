import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { httpErrorResponse, studyPdfPath } from "@/src/server";

export const dynamic = "force-dynamic";

/** The stored copy of the document's PDF, for the viewer. Streamed from disk, never buffered whole. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const file = studyPdfPath(id);
		const { size } = await stat(file);
		const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
		return new Response(body, {
			headers: { "Content-Type": "application/pdf", "Content-Length": String(size), "Cache-Control": "private, max-age=3600" },
		});
	} catch (error) {
		return httpErrorResponse(error);
	}
}
