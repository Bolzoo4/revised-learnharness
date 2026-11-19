import { NextResponse } from "next/server";
import { accessSettings, pairingStore } from "@/src/server";

/** Create a one-time pairing code. The gate lets only a signed-in, same-origin caller reach this. */
export async function POST() {
	const settings = accessSettings();
	if (settings.mode === "open" || !settings.token) return NextResponse.json({ error: "not_available" }, { status: 404 });
	const { code, expiresAt } = pairingStore().create(Date.now());
	return NextResponse.json({ code, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
