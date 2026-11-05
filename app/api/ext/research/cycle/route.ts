// app/api/ext/research/cycle/route.ts
import {
	HttpError,
	httpErrorResponse,
	readJsonObject,
	researchService,
	type RunTrigger,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → ResearchStatus */
export async function GET() {
	try {
		return Response.json(researchService.status());
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { action: "start" | "steer" | "abort", trigger?: string, message?: string } */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const action = body.action;
		if (action === "start") {
			const trigger = (body.trigger as RunTrigger) ?? "manual";
			const result = researchService.start(trigger);
			return Response.json(result);
		}
		if (action === "steer") {
			const message = typeof body.message === "string" ? body.message : "";
			const result = researchService.steer(message);
			return Response.json({ status: result });
		}
		if (action === "abort") {
			const result = researchService.abort();
			return Response.json({ aborted: result });
		}
		throw new HttpError(400, "invalid action");
	} catch (error) {
		return httpErrorResponse(error);
	}
}
