import { httpErrorResponse, readJsonObject, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** The registered documents with their reading summary. */
export async function GET() {
	return Response.json({ documents: studyService.listDocuments() });
}

/** POST { path, title? }: registers the PDF at an absolute local path (REQ-study-01). → 201 the document. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(await studyService.registerDocument({ path: body.path, title: body.title }), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
