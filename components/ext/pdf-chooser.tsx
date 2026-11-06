"use client";

import { useState } from "react";
import { pickPdf } from "./pdf-upload.ts";

/**
 * The "choose or drop a PDF" control for the study and lectures pages. It checks
 * the chosen file (pickPdf) and hands it up; the page owns the request, its busy
 * state and its error text.
 */
export function PdfChooser({ busy, onPick, onError }: { busy: boolean; onPick: (file: File, title: string) => void; onError: (text: string) => void }) {
	const [title, setTitle] = useState("");
	const [over, setOver] = useState(false);

	function choose(files: ArrayLike<File>) {
		const pick = pickPdf(files);
		if (pick.ok) onPick(pick.file, title);
		else onError(pick.error);
	}

	return (
		<div className="flex flex-col gap-3">
			<div
				className={`flex flex-col items-start gap-2 rounded border p-4 ${over ? "bg-muted" : ""}`}
				onDragOver={(e) => {
					e.preventDefault();
					if (!busy) setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setOver(false);
					if (!busy) choose(e.dataTransfer.files);
				}}
			>
				<p className="text-sm text-muted-foreground">{busy ? "Reading the PDF…" : "Drop a PDF here, or"}</p>
				<label className={`rounded border px-3 py-1 ${busy ? "opacity-50" : "cursor-pointer"}`}>
					Choose a PDF
					<input
						type="file"
						accept="application/pdf,.pdf"
						className="sr-only"
						disabled={busy}
						onChange={(e) => {
							const input = e.currentTarget;
							// Copy before clearing: resetting the input empties its live FileList.
							const picked = Array.from(input.files ?? []);
							input.value = "";
							choose(picked);
						}}
					/>
				</label>
			</div>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">Title (optional)</span>
				<input className="rounded border px-2 py-1" value={title} onChange={(e) => setTitle(e.target.value)} />
			</label>
		</div>
	);
}
