import { HttpError, httpErrorResponse, personalLayer, readJsonObject, type MarkRequest } from "@/src/server";

/** The review service reports a node or goal it does not know as "unknown node: …" / "unknown goal: …". */
const UNKNOWN_TARGET = /^unknown (node|goal):/;

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
		try {
			personalLayer.mark(mark);
		} catch (e) {
			// Domain rejections of the review service are plain Errors: an unknown target is a 404, any other rejection (e.g. retention out of range) a 400.
			if (e instanceof Error && UNKNOWN_TARGET.test(e.message)) throw new HttpError(404, e.message);
			if (e instanceof Error && !(e instanceof HttpError) && /must be|only /.test(e.message)) throw new HttpError(400, e.message);
			throw e;
		}
		return Response.json({ ok: true });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
