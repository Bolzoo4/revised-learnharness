import { httpErrorResponse, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** Opens a document: creates its one conversation the first time (REQ-study-05). → { document, chatId, page, readPages }. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json(await studyService.open(id));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
