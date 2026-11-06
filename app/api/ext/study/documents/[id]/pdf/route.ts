import { httpErrorResponse, readStudyPdf } from "@/src/server";

export const dynamic = "force-dynamic";

/** The stored copy of the document's PDF, for the viewer. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const bytes = readStudyPdf(id);
		return new Response(new Uint8Array(bytes), {
			headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=3600" },
		});
	} catch (error) {
		return httpErrorResponse(error);
	}
}
