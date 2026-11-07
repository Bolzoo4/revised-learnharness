import { examSessionService, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { collectionId, exerciseId }: starts an exam session on one exercise of a reviewed exam. → { chatId }. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(examSessionService.start(body));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
