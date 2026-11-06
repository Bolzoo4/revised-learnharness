"use client";

import Link from "next/link";
import { useState } from "react";

interface DocumentRow {
	id: string;
	title: string;
	pageCount: number;
	lastPage: number | null;
	readCount: number;
}

/** The list of registered documents and the form that registers a PDF from a local path (REQ-study-01). */
export function StudyHome({ initial }: { initial: DocumentRow[] }) {
	const [documents, setDocuments] = useState(initial);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function register() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/ext/study/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path.trim() }) });
			const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			if (!res.ok) {
				setError(typeof json.error === "string" ? json.error : "Request failed.");
				return;
			}
			const list = await fetch("/api/ext/study/documents");
			if (list.ok) setDocuments(((await list.json()) as { documents: DocumentRow[] }).documents);
			setPath("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Add a PDF</h2>
				<p className="text-sm text-muted-foreground">Paste the full path of a PDF on this computer. A copy is stored and the PDF becomes a primary source for checking what you learn from it.</p>
				<input className="rounded border px-2 py-1" placeholder="/Users/you/Books/probability.pdf" value={path} onChange={(e) => setPath(e.target.value)} />
				<button type="button" className="self-start rounded border px-3 py-1" disabled={busy || path.trim() === ""} onClick={() => void register()}>
					{busy ? "Reading the PDF…" : "Add"}
				</button>
				{error !== null ? <p className="text-destructive">{error}</p> : null}
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Your documents</h2>
				{documents.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
				{documents.map((d) => (
					<p key={d.id}>
						<Link className="underline" href={`/study/${d.id}`}>
							{d.title}
						</Link>{" "}
						<span className="text-sm text-muted-foreground">
							{d.pageCount} pages, {d.readCount} read{d.lastPage !== null ? `, last on p. ${d.lastPage}` : ""}
						</span>
					</p>
				))}
			</section>
		</div>
	);
}
