// app/api/ext/research/inbox/route.ts
import {
	HttpError,
	httpErrorResponse,
	InboxError,
	readJsonObject,
	researchAdmin,
	ResearchInputError,
	type InboxDecision,
	type InboxStatus,
	type SourceTier,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?status=...&limit=N → { items: InboxItem[] } */
export async function GET(req?: Request) {
	try {
		const url = req ? new URL(req.url) : null;
		const status = url?.searchParams.get("status") ?? undefined;
		const limitParam = url?.searchParams.get("limit") ?? null;
		const limit = limitParam !== null ? Number(limitParam) : undefined;
		return Response.json({ items: researchAdmin.listInbox(status as InboxStatus | undefined, limit) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { locator, decision, tier? } → InboxDecisionResult */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const result = await researchAdmin.decideInbox(
			body.locator as string,
			body.decision as InboxDecision,
			body.tier as SourceTier | undefined,
		);
		return Response.json(result);
	} catch (error) {
		if (error instanceof InboxError) {
			const status = error.code === "not-found" ? 404 : 400;
			return httpErrorResponse(new HttpError(status, error.message));
		}
		if (error instanceof ResearchInputError) {
			const status = error.message === "no pending inbox source at that locator" ? 404 : 400;
			return httpErrorResponse(new HttpError(status, error.message));
		}
		return httpErrorResponse(error);
	}
}
