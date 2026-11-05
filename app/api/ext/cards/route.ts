import { personalLayer } from "@/src/server";

export const dynamic = "force-dynamic";

/** All cards, optionally for one node: GET /api/ext/cards?nodeId=n_… */
export async function GET(req: Request) {
	const nodeId = new URL(req.url).searchParams.get("nodeId") ?? undefined;
	return Response.json({ cards: personalLayer.listCards(nodeId) });
}

/** The user writes a fixed card (active at once). */
export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as { nodeId?: unknown; question?: unknown; answer?: unknown } | null;
	if (!b || typeof b.nodeId !== "string" || typeof b.question !== "string" || typeof b.answer !== "string" || !b.question.trim() || !b.answer.trim()) {
		return Response.json({ error: "nodeId, question and answer are required" }, { status: 400 });
	}
	try {
		return Response.json(personalLayer.createCard({ nodeId: b.nodeId, question: b.question.trim(), answer: b.answer.trim() }));
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
