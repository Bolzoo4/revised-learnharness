import { HttpError, httpErrorResponse, personalLayer, readJsonObject, ReviewInputError, type MarkRequest } from "@/src/server";

/** Manual marks: pin, retire, channel pin of a node, or the desired retention of a goal. */
export async function POST(req: Request) {
	try {
		const b = await readJsonObject(req);
		let mark: MarkRequest | null = null;
		if (typeof b.goalId === "string" && typeof b.retention === "number") mark = { goalId: b.goalId, retention: b.retention };
		else if (typeof b.nodeId === "string" && typeof b.pinned === "boolean") mark = { nodeId: b.nodeId, pinned: b.pinned };
		else if (typeof b.nodeId === "string" && typeof b.retired === "boolean") mark = { nodeId: b.nodeId, retired: b.retired };
		else if (typeof b.nodeId === "string" && (b.channel === null || b.channel === "fixed" || b.channel === "dialogic")) {
			mark = { nodeId: b.nodeId, channel: b.channel };
		}
		if (mark === null) throw new HttpError(400, "invalid mark");
		personalLayer.mark(mark);
		return Response.json({ ok: true });
	} catch (error) {
		// A rejected mark is a 404 for an unknown node or goal and a 400 for any other rule violation.
		if (error instanceof ReviewInputError) return httpErrorResponse(new HttpError(error.kind === "unknown" ? 404 : 400, error.message));
		return httpErrorResponse(error);
	}
}
