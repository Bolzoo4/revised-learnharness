import { examsService, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** The collections, oldest first. → { collections }. */
export async function GET() {
	try {
		return Response.json({ collections: examsService.listCollections() });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { title }: creates a collection. → 201 the collection. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(examsService.createCollection(body.title), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
