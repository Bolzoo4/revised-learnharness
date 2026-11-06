import { debriefService, httpErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json({ entry: debriefService.get(id) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
