import { httpErrorResponse, importIntoWorkspace, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { paths: string[] }: copies the files into the agent's workspace. → { paths, errors } (paths in the same order). */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const paths = Array.isArray(body.paths) && body.paths.length <= 50 && body.paths.every((p) => typeof p === "string" && p.length <= 4096) ? (body.paths as string[]) : null;
		if (paths === null) return Response.json({ error: "paths must be a list of at most 50 file paths" }, { status: 400 });
		return Response.json(importIntoWorkspace(paths));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
