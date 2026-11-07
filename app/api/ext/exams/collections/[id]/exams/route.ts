import { httpErrorResponse, uploadExamPdf } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST multipart/form-data (file, title?): stores the exam PDF and splits it into exercises. → 201 the exam. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json(await uploadExamPdf(id, "exam", req), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
