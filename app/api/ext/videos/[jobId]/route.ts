import { stores, videoResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → the rendered mp4 of one video job (REQ-vid-10). A Range header is honoured. */
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
	const { jobId } = await params;
	return videoResponse(stores.jobStore.getJob(jobId), jobId, req.headers.get("range"));
}
