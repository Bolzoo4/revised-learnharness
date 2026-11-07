import { httpErrorResponse, uploadExamPdf } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST multipart/form-data (file, title?): indexes the material PDF once. → 201 the material. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json(await uploadExamPdf(id, "material", req), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
