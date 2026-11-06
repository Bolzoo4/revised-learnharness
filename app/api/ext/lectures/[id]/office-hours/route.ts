import { httpErrorResponse, lectureOfficeHours, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { blockId } → 201 { chatId }: an office-hours session on the lecture's chapter, with this exercise as its focus. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const body = await readJsonObject(req);
		const view = await lectureOfficeHours.open(id, body.blockId);
		return Response.json(view, { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
