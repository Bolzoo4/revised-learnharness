import { ExamsError, examsService, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** The exercises of an exam, in order. → { exercises }. */
export async function GET(_req: Request, { params }: { params: Promise<{ examId: string }> }) {
	try {
		const { examId } = await params;
		return Response.json({ exercises: examsService.listExercises(examId) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** PATCH { op: merge | split | delete | edit, ... } (REQ-ex-03): one edit of the list. → { exercises }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ examId: string }> }) {
	try {
		const { examId } = await params;
		const body = await readJsonObject(req);
		return Response.json({ exercises: examsService.editExercises(examId, body) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { action: "reviewed" }: marks the exam reviewed, so its exercises can be practised. → the exam. */
export async function POST(req: Request, { params }: { params: Promise<{ examId: string }> }) {
	try {
		const { examId } = await params;
		const body = await readJsonObject(req);
		if (body.action !== "reviewed") throw new ExamsError(400, 'action must be "reviewed"');
		return Response.json(examsService.markReviewed(examId));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
