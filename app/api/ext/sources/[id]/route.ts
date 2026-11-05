// app/api/ext/sources/[id]/route.ts
import { setLibrarySourceStatus } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * PATCH { status: "active" | "proposed", tier?: "primary" | "secondary" }.
 * Activating is the user's decision (agent proposals never self-activate) and
 * starts a background re-verification of in-scope unverified/contested nodes.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { status?: unknown; tier?: unknown };
	if (body.status !== "active" && body.status !== "proposed") return Response.json({ error: 'status must be "active" or "proposed".' }, { status: 400 });
	if (body.tier !== undefined && body.tier !== "primary" && body.tier !== "secondary") return Response.json({ error: 'tier must be "primary" or "secondary".' }, { status: 400 });
	try {
		return Response.json({ source: setLibrarySourceStatus(id, body.status, body.tier) });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not update the source." }, { status: 404 });
	}
}
