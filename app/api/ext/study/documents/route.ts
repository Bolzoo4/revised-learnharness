import { httpErrorResponse, isPdfUpload, readJsonObject, stagePdfUpload, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** The registered documents with their reading summary. */
export async function GET() {
	return Response.json({ documents: studyService.listDocuments() });
}

/**
 * POST { path, title? }: registers the PDF at an absolute local path (REQ-study-01). → 201 the document.
 * POST multipart/form-data (file, title?): the chosen PDF is staged in a private temp copy, registered,
 * and the copy is deleted whether or not the registration succeeded.
 */
export async function POST(req: Request) {
	try {
		if (isPdfUpload(req)) {
			const staged = await stagePdfUpload(req);
			try {
				return Response.json(await studyService.registerDocument({ path: staged.path, title: staged.title }), { status: 201 });
			} finally {
				await staged.release();
			}
		}
		const body = await readJsonObject(req);
		return Response.json(await studyService.registerDocument({ path: body.path, title: body.title }), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
