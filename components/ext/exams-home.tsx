"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ExamCollection as Collection } from "@/src/core";
import { createCollection, listCollections } from "./exams-api.ts";
import { collectionTitleValid } from "./exams-logic.ts";

/** The collections of exams and material (REQ-ex-01). Each row opens the collection page. */
export function ExamsHome() {
	const [collections, setCollections] = useState<Collection[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		void listCollections(fetch).then((r) => {
			if (!alive) return;
			if (r.ok) setCollections(r.value);
			else setError(r.error);
		});
		return () => {
			alive = false;
		};
	}, []);

	async function create(title: string): Promise<boolean> {
		setBusy(true);
		setError(null);
		const r = await createCollection(fetch, title.trim());
		setBusy(false);
		if (!r.ok) {
			setError(r.error);
			return false;
		}
		setCollections((list) => [...(list ?? []), r.value]);
		return true;
	}

	return (
		<div className="flex flex-col gap-6">
			<CreateCollectionForm busy={busy} onCreate={create} />
			{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
			{collections === null ? <p className="text-sm text-muted-foreground">Loading the collections…</p> : <CollectionList collections={collections} />}
		</div>
	);
}

/** The form that makes a collection; it clears its field after a successful create. */
export function CreateCollectionForm({ busy, onCreate }: { busy: boolean; onCreate: (title: string) => Promise<boolean> }) {
	const [title, setTitle] = useState("");
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!busy && collectionTitleValid(title)) void onCreate(title).then((ok) => ok && setTitle(""));
			}}
		>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">New collection</span>
				<span className="flex gap-2">
					<input className="flex-1 rounded border px-2 py-1" placeholder="Analisi 1, esame di giugno" value={title} onChange={(e) => setTitle(e.target.value)} />
					<button type="submit" className="rounded border px-3 py-1" disabled={busy || !collectionTitleValid(title)}>
						Create
					</button>
				</span>
			</label>
		</form>
	);
}

/** The rows of the collections; an empty list says how to start. */
export function CollectionList({ collections }: { collections: Collection[] }) {
	if (collections.length === 0) return <p className="text-sm text-muted-foreground">No collections yet. Create one above, then add its exams and material.</p>;
	return (
		<ul className="flex flex-col gap-2">
			{collections.map((c) => (
				<li key={c.id}>
					<Link href={`/exams/${encodeURIComponent(c.id)}`} className="block rounded border px-3 py-2 text-sm hover:bg-accent">
						{c.title}
					</Link>
				</li>
			))}
		</ul>
	);
}
