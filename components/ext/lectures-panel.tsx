"use client";

import { useCallback, useEffect, useState } from "react";
import { PdfChooser } from "./pdf-chooser.tsx";
import { failureText, uploadPdf } from "./pdf-upload.ts";

const UPLOAD_REJECTED = "Could not start the ingest. Choose a PDF file and try again.";

interface ChapterRow { chapter: { index: number; title: string }; state: string; lectures: number; uncovered: number; error?: string }
interface RunRow { bookId: string; title: string; phase: string; error?: string; chapters: ChapterRow[] }
interface LectureRow { id: string; title: string; bookTitle: string; chapter: { index: number; title: string }; order: number }

/** Lectures page: ingest a book PDF (absolute path), follow the per-chapter progress, open lectures (REQ-lec-01 to 08). */
export function LecturesPanel() {
	const [pdfPath, setPdfPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [runs, setRuns] = useState<RunRow[]>([]);
	const [lectures, setLectures] = useState<LectureRow[]>([]);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/ext/lectures");
		if (!res.ok) return;
		const body = (await res.json()) as { runs: RunRow[]; lectures: LectureRow[] };
		setRuns(body.runs);
		setLectures(body.lectures);
	}, []);
	useEffect(() => {
		void refresh();
		const t = setInterval(() => void refresh(), 3000);
		return () => clearInterval(t);
	}, [refresh]);

	async function ingest() {
		setError(null);
		setBusy(true);
		try {
			const res = await fetch("/api/ext/lectures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdfPath }) });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start the ingest.");
			else void refresh();
		} finally {
			setBusy(false);
		}
	}

	/** The chosen or dropped book, uploaded to the same route; the run continues in the background. */
	async function ingestFile(file: File, title: string) {
		setError(null);
		setBusy(true);
		try {
			const res = await uploadPdf(fetch, "/api/ext/lectures", file, title);
			if (!res.ok) setError(await failureText(res, UPLOAD_REJECTED));
			else void refresh();
		} catch {
			setError(UPLOAD_REJECTED);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Make lectures from a book</h2>
				<p className="text-sm text-muted-foreground">Choose a PDF of a book or drop it here. Each chapter becomes lectures, and the progress shows below.</p>
				<PdfChooser busy={busy} onPick={(file, title) => void ingestFile(file, title)} onError={setError} />
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">Or paste a path</summary>
					<form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ingest(); }}>
						<input className="flex-1 rounded border px-2 py-1" placeholder="/absolute/path/to/book.pdf" value={pdfPath} onChange={(e) => setPdfPath(e.target.value)} />
						<button type="submit" className="rounded border px-3 py-1" disabled={busy || pdfPath.trim() === ""}>Make lectures</button>
					</form>
				</details>
			</section>
			{error !== null ? <p className="text-destructive">{error}</p> : null}
			{runs.map((r) => (
				<section key={r.bookId} className="rounded border p-3">
					<h2 className="font-medium">{r.title} <span className="text-xs text-muted-foreground">{r.phase}</span></h2>
					{r.error ? <p className="text-destructive">{r.error}</p> : null}
					<ul className="text-sm">
						{r.chapters.map((c) => (
							<li key={c.chapter.index}>
								{c.chapter.index}. {c.chapter.title}: {c.state}, {c.lectures} lectures{c.uncovered > 0 ? `, ${c.uncovered} nodes not covered` : ""}{c.error ? ` (${c.error})` : ""}
							</li>
						))}
					</ul>
				</section>
			))}
			<section>
				<h2 className="mb-2 font-medium">Lectures</h2>
				{lectures.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
					<ul className="flex flex-col gap-1">
						{lectures.map((l) => (
							<li key={l.id}><a className="underline" href={`/lectures/${l.id}`}>{l.bookTitle} · ch. {l.chapter.index} · {l.order}. {l.title}</a></li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
