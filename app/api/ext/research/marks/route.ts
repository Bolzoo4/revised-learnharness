// app/api/ext/research/marks/route.ts
import { HttpError, httpErrorResponse, readJsonObject, researchAdmin, ResearchInputError, type SetMarkInput } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?limit=N → { marks: Mark[] } */
export async function GET(req?: Request) {
	try {
		const url = req ? new URL(req.url) : null;
		const limitParam = url?.searchParams.get("limit") ?? null;
		const limit = limitParam !== null ? Number(limitParam) : undefined;
		return Response.json({ marks: researchAdmin.listMarks(limit) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST SetMarkInput → 201 { mark: Mark } */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const mark = researchAdmin.setMark(body as unknown as SetMarkInput);
		return Response.json({ mark }, { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** DELETE ?id=... or body { id } → { ok: true } */
export async function DELETE(req: Request) {
	try {
		const url = new URL(req.url);
		let id = url.searchParams.get("id");
		if (!id) {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			if (typeof body.id === "string") id = body.id;
		}
		if (!id) throw new HttpError(400, "an id is required");
		researchAdmin.clearMark(id);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof ResearchInputError && error.message === "no such mark") {
			return httpErrorResponse(new HttpError(404, error.message));
		}
		return httpErrorResponse(error);
	}
}
