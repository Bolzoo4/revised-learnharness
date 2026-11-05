import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const lecture = lectureService.getLecture(id);
	return lecture ? Response.json({ lecture }) : Response.json({ error: "unknown lecture" }, { status: 404 });
}
