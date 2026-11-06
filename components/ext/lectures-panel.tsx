"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LecturesTree } from "./lectures-tree.tsx";
import { buildLectureTree, type LectureRow, type RunRow, type TreeBook } from "./lectures-tree.ts";
import { PdfChooser } from "./pdf-chooser.tsx";
import { failureText, uploadPdf } from "./pdf-upload.ts";

const UPLOAD_REJECTED = "Could not start the ingest. Choose a PDF file and try again.";

/** The tree with navigation: a child component, so the router is read only when there is a tree to show. */
function NavigatingTree({ books }: { books: TreeBook[] }) {
	const router = useRouter();
	return <LecturesTree books={books} onStarted={(chatId) => router.push(`/chat/${chatId}`)} />;
}

/** Lectures page: ingest a book PDF, follow the per-chapter progress, and open lectures and their exercises (REQ-lec-01 to 08). */
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

	const books = buildLectureTree(runs, lectures);

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
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Books, chapters and lectures</h2>
				{books.length === 0 ? (
					<p className="text-sm text-muted-foreground">No lectures yet. Choose a book above to make them; each chapter's lectures and exercises will appear here.</p>
				) : (
					<NavigatingTree books={books} />
				)}
			</section>
		</div>
	);
}
