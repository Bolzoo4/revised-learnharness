import { personalLayer } from "@/src/server";

/** Approve an agent draft or retire a card: body { action: "approve" | "retire" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const b = (await req.json().catch(() => null)) as { action?: unknown } | null;
	if (!b || (b.action !== "approve" && b.action !== "retire")) {
		return Response.json({ error: 'action must be "approve" or "retire"' }, { status: 400 });
	}
	try {
		personalLayer.cardAction(id, b.action);
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
