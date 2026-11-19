/** Unauthenticated liveness and version probe (spec REQ-service-14): no other data. */
export function GET() {
	return Response.json({ ok: true, version: process.env.LH_VERSION ?? "dev" }, { headers: { "cache-control": "no-store" } });
}
