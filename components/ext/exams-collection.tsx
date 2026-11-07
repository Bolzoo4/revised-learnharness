"use client";

import { useEffect, useState } from "react";
import type { ExamDoc, MaterialDoc } from "./exams-types.ts";
import { ExamReview } from "./exams-review.tsx";
import { getCollection, uploadExam, uploadMaterial, type CollectionDetail } from "./exams-api.ts";
import { PdfChooser } from "./pdf-chooser.tsx";

/**
 * One collection: its Exams and its Material, each with the PDF chooser (the file name is the title).
 * Choosing an exam opens its review list below (ExamReview). Loads and uploads here; the lists are presentational.
 */
export function CollectionView({ collectionId }: { collectionId: string }) {
	const [detail, setDetail] = useState<CollectionDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		void getCollection(fetch, collectionId).then((r) => {
			if (!alive) return;
			if (r.ok) setDetail(r.value);
			else setError(r.error);
		});
		return () => {
			alive = false;
		};
	}, [collectionId]);

	async function addExam(file: File, title: string) {
		setBusy(true);
		setError(null);
		const r = await uploadExam(fetch, collectionId, file, title);
		setBusy(false);
		if (!r.ok) return setError(r.error);
		setDetail((d) => (d === null ? d : { ...d, exams: [...d.exams, r.value] }));
		setSelectedId(r.value.id);
	}

	async function addMaterial(file: File, title: string) {
		setBusy(true);
		setError(null);
		const r = await uploadMaterial(fetch, collectionId, file, title);
		setBusy(false);
		if (!r.ok) return setError(r.error);
		setDetail((d) => (d === null ? d : { ...d, materials: [...d.materials, r.value] }));
	}

	function examChanged(exam: ExamDoc) {
		setDetail((d) => (d === null ? d : { ...d, exams: d.exams.map((e) => (e.id === exam.id ? exam : e)) }));
	}

	if (detail === null) {
		return error !== null ? <p className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">Loading the collection…</p>;
	}
	const selected = detail.exams.find((e) => e.id === selectedId) ?? null;

	return (
		<div className="flex flex-col gap-8">
			<h2 className="text-lg font-medium">{detail.collection.title}</h2>
			{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}

			<section className="flex flex-col gap-3" aria-label="Exams">
				<h3 className="font-medium">Exams</h3>
				<p className="text-sm text-muted-foreground">Each exam is split into exercises. You review the split, then practise each exercise.</p>
				<PdfChooser busy={busy} onPick={(file, title) => void addExam(file, title)} onError={setError} />
				<ExamList exams={detail.exams} selectedId={selectedId} onReview={setSelectedId} />
			</section>

			{selected !== null ? (
				<section className="flex flex-col gap-3" aria-label="Review of the selected exam">
					<h3 className="font-medium">{selected.title}</h3>
					<ExamReview key={selected.id} collectionId={collectionId} exam={selected} onExamChanged={examChanged} />
				</section>
			) : null}

			<section className="flex flex-col gap-3" aria-label="Material">
				<h3 className="font-medium">Material</h3>
				<p className="text-sm text-muted-foreground">Course notes and books. Practice looks here before it searches the web.</p>
				<PdfChooser busy={busy} onPick={(file, title) => void addMaterial(file, title)} onError={setError} />
				<MaterialList materials={detail.materials} />
			</section>
		</div>
	);
}

/** The exams of a collection with their review state; "Review exercises" opens the list. */
export function ExamList({ exams, selectedId, onReview }: { exams: ExamDoc[]; selectedId: string | null; onReview: (id: string) => void }) {
	if (exams.length === 0) return <p className="text-sm text-muted-foreground">No exams yet. Choose an exam PDF above.</p>;
	return (
		<ul className="flex flex-col gap-2">
			{exams.map((exam) => (
				<li key={exam.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
					<span className="min-w-0 truncate">
						{exam.title} <span className="text-muted-foreground">· {exam.pages} {exam.pages === 1 ? "page" : "pages"} · {exam.reviewed ? "reviewed" : "not reviewed yet"}</span>
					</span>
					<button type="button" className="rounded border px-2 py-1" aria-pressed={selectedId === exam.id} onClick={() => onReview(exam.id)}>
						Review exercises
					</button>
				</li>
			))}
		</ul>
	);
}

/** The material of a collection, one row per indexed PDF. */
export function MaterialList({ materials }: { materials: MaterialDoc[] }) {
	if (materials.length === 0) return <p className="text-sm text-muted-foreground">No material yet. Choose a PDF above to index it.</p>;
	return (
		<ul className="flex flex-col gap-2">
			{materials.map((m) => (
				<li key={m.id} className="rounded border px-3 py-2 text-sm">
					{m.title} <span className="text-muted-foreground">· {m.pages} {m.pages === 1 ? "page" : "pages"}</span>
				</li>
			))}
		</ul>
	);
}
