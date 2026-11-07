import Link from "next/link";
import { CollectionView } from "@/components/ext/exams-collection";
import { ExtPageShell } from "@/components/ext/ext-page-shell";

export const dynamic = "force-dynamic";

/** One collection: its exams (with the exercise review) and its material (REQ-ex-12). */
export default async function CollectionPage({ params }: { params: Promise<{ collectionId: string }> }) {
	const { collectionId } = await params;
	return (
		<ExtPageShell title="Exams" wide>
			<Link className="text-sm underline" href="/exams">
				All collections
			</Link>
			<CollectionView collectionId={collectionId} />
		</ExtPageShell>
	);
}
