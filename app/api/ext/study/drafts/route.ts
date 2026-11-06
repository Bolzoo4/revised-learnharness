import { httpErrorResponse, parseDecision, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?documentId=…: the pending drafts of a document. */
export async function GET(req: Request) {
	try {
		const documentId = new URL(req.url).searchParams.get("documentId") ?? "";
		if (documentId === "") throw new StudyError(400, "documentId is required");
		return Response.json({ drafts: studyService.listDrafts(documentId) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/**
 * POST { action: "complete", documentId }: proposes drafts for pages read and not yet processed (REQ-study-11, 13).
 * POST { action: "decide", approve?, reject? }: the batch approval. Nothing is written to the graph before this.
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		if (body.action === "complete") return Response.json(await studyService.complete(requireString(body, "documentId")));
		if (body.action === "decide") return Response.json(await studyService.decideDrafts(parseDecision(body)));
		throw new StudyError(400, 'action must be "complete" or "decide"');
	} catch (error) {
		return httpErrorResponse(error);
	}
}
