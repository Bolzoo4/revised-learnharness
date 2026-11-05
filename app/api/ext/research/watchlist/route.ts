// app/api/ext/research/watchlist/route.ts
import {
	HttpError,
	httpErrorResponse,
	readJsonObject,
	researchAdmin,
	ResearchInputError,
	type AddWatchInput,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?limit=N → { entries: WatchEntry[] } */
export async function GET(req?: Request) {
	try {
		const url = req ? new URL(req.url) : null;
		const limitParam = url?.searchParams.get("limit") ?? null;
		const limit = limitParam !== null ? Number(limitParam) : undefined;
		return Response.json({ entries: researchAdmin.listWatchlist(limit) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { kind, query, cadenceHours?, goalId? } → 201 { entry: WatchEntry } */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const entry = researchAdmin.addWatch(body as unknown as AddWatchInput);
		return Response.json({ entry }, { status: 201 });
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
		researchAdmin.removeWatch(id);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof ResearchInputError && error.message === "no such watch entry") {
			return httpErrorResponse(new HttpError(404, error.message));
		}
		return httpErrorResponse(error);
	}
}
