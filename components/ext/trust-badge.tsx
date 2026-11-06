// components/ext/trust-badge.tsx
"use client";

import { useCallback, useEffect, useState } from "react";

/** Local mirror of the API shape (components import only the core barrel, so no ext import). */
type Level = "unverified" | "sourced" | "contested" | "refuted";
interface EvidenceView {
	sourceRef: string;
	locator: string;
	quote: string;
	stance: "supports" | "contradicts";
	tier: "primary" | "secondary" | "unvetted";
}

export function TrustBadgeView(props: {
	level: Level;
	evidence: EvidenceView[];
	busy: boolean;
	error: string | null;
	onVerify: () => void;
}) {
	return (
		<div className="mt-2 text-xs">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Trust:</span>
				<span className="font-medium">{props.level}</span>
				<button type="button" className="ml-auto underline" disabled={props.busy} onClick={props.onVerify}>
					{props.busy ? "Verifying…" : "Verify"}
				</button>
			</div>
			{props.error !== null ? <div className="mt-1 text-destructive">{props.error}</div> : null}
			{props.evidence.length > 0 ? (
				<ul className="mt-1 flex flex-col gap-1">
					{props.evidence.map((e, i) => (
						<li key={i} className="text-muted-foreground">
							<span>{e.stance} · {e.tier} · {e.sourceRef} {e.locator}</span>
							<div>“{e.quote}”</div>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function TrustBadge({ nodeId }: { nodeId: string }) {
	const [level, setLevel] = useState<Level>("unverified");
	const [evidence, setEvidence] = useState<EvidenceView[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/ext/verification?nodeId=${encodeURIComponent(nodeId)}`);
			const body = (await res.json()) as { trust?: { level: Level; evidence: EvidenceView[] }[] };
			const view = body.trust?.[0];
			setLevel(view?.level ?? "unverified");
			setEvidence(view?.evidence ?? []);
		} catch {
			setError("Could not load verification.");
		}
	}, [nodeId]);

	useEffect(() => {
		setError(null);
		void load();
	}, [load]);

	const verify = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/ext/verification", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nodeIds: [nodeId] }),
			});
			const body = (await res.json()) as { error?: string; failed?: string[]; skippedBudget?: string[]; providerLimited?: string[] };
			if (!res.ok) setError(body.error ?? "Verification failed.");
			else if ((body.failed?.length ?? 0) > 0) setError("The check failed; the trust level is unchanged.");
			else if ((body.providerLimited?.length ?? 0) > 0) setError("The AI provider's usage limit is reached; try again later.");
			else if ((body.skippedBudget?.length ?? 0) > 0) setError("The daily cost ceiling is reached.");
			await load();
		} catch {
			setError("Verification failed.");
		} finally {
			setBusy(false);
		}
	}, [nodeId, load]);

	return <TrustBadgeView level={level} evidence={evidence} busy={busy} error={error} onVerify={() => void verify()} />;
}
