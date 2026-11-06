"use client";

import Link from "next/link";
import { useState } from "react";
import { PdfChooser } from "./pdf-chooser.tsx";
import { failureText, uploadPdf } from "./pdf-upload.ts";
import { REQUEST_FAILED } from "./study-logic";

const REJECTED = "The PDF could not be added. Check that the path points to a PDF file on this computer.";
const UPLOAD_REJECTED = "The PDF could not be added. Choose a PDF file and try again.";

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

	async function reloadDocuments() {
		const list = await fetch("/api/ext/study/documents");
		if (list.ok) {
			const json = (await list.json().catch(() => ({}))) as { documents?: unknown };
			if (Array.isArray(json.documents)) setDocuments(json.documents as DocumentRow[]);
		}
	}

	/** The chosen or dropped PDF, uploaded to the same route as the path form. */
	async function registerFile(file: File, title: string) {
		setBusy(true);
		setError(null);
		try {
			const res = await uploadPdf(fetch, "/api/ext/study/documents", file, title);
			if (!res.ok) {
				setError(await failureText(res, UPLOAD_REJECTED));
				return;
			}
			await reloadDocuments();
		} catch {
			setError(REQUEST_FAILED);
		} finally {
			setBusy(false);
		}
	}

	async function register() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/ext/study/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path.trim() }) });
			if (!res.ok) {
				// Fixed text only: the server's message is never shown.
				setError(REJECTED);
				return;
			}
			await reloadDocuments();
			setPath("");
		} catch {
			setError(REQUEST_FAILED);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Add a PDF</h2>
				<p className="text-sm text-muted-foreground">Choose a PDF from this computer or drop it here. A copy is stored and the PDF becomes a primary source for checking what you learn from it.</p>
				<PdfChooser busy={busy} onPick={(file, title) => void registerFile(file, title)} onError={setError} />
				{error !== null ? <p className="text-destructive">{error}</p> : null}
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">Or paste a path</summary>
					<div className="mt-2 flex flex-col gap-2">
						<input className="rounded border px-2 py-1" placeholder="/Users/you/Books/probability.pdf" value={path} onChange={(e) => setPath(e.target.value)} />
						<button type="button" className="self-start rounded border px-3 py-1" disabled={busy || path.trim() === ""} onClick={() => void register()}>
							{busy ? "Reading the PDF…" : "Add"}
						</button>
					</div>
				</details>
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
