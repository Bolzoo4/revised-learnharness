// app/api/ext/sources/route.ts
import { addLibrarySource, listLibrarySources } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json({ sources: listLibrarySources() });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not read the source library." }, { status: 500 });
	}
}

/** POST { kind, locator, tier, label, author? } → the new ACTIVE entry (a user-added source). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const entry = addLibrarySource({
			kind: body.kind as "pdf" | "url-prefix" | "repo",
			locator: String(body.locator ?? ""),
			tier: body.tier as "primary" | "secondary",
			label: String(body.label ?? ""),
			...(typeof body.author === "string" ? { author: body.author } : {}),
		});
		return Response.json({ source: entry }, { status: 201 });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not add the source." }, { status: 400 });
	}
}
