// app/api/ext/research/log/route.ts
import { httpErrorResponse, researchAdmin } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?limit=N → { log: CycleLogEntry[] } */
export async function GET(req?: Request) {
	try {
		const url = req ? new URL(req.url) : null;
		const limitParam = url?.searchParams.get("limit") ?? null;
		const limit = limitParam !== null ? Number(limitParam) : undefined;
		return Response.json({ log: researchAdmin.readLog(limit) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
