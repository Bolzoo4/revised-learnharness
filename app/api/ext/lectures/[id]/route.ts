import { HttpError, httpErrorResponse, lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const lecture = lectureService.getLecture(id);
		if (!lecture) throw new HttpError(404, "unknown lecture");
		return Response.json({ lecture });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
