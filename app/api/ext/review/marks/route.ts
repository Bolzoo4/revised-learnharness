import { personalLayer, type MarkRequest } from "@/src/server";

/** Manual marks: pin, retire, channel pin of a node, or the desired retention of a goal. */
export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	let mark: MarkRequest | null = null;
	if (b && typeof b.goalId === "string" && typeof b.retention === "number") mark = { goalId: b.goalId, retention: b.retention };
	else if (b && typeof b.nodeId === "string" && typeof b.pinned === "boolean") mark = { nodeId: b.nodeId, pinned: b.pinned };
	else if (b && typeof b.nodeId === "string" && typeof b.retired === "boolean") mark = { nodeId: b.nodeId, retired: b.retired };
	else if (b && typeof b.nodeId === "string" && (b.channel === null || b.channel === "fixed" || b.channel === "dialogic")) {
		mark = { nodeId: b.nodeId, channel: b.channel };
	}
	if (mark === null) return Response.json({ error: "invalid mark" }, { status: 400 });
	try {
		personalLayer.mark(mark);
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
}
