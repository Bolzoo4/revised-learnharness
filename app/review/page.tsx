import Link from "next/link";
import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { ReviewPanel } from "@/components/ext/review-panel";
import { personalLayer } from "@/src/server";

export const dynamic = "force-dynamic";

/** Flashcards for today's plan and the card list. No agent runs here; "Ask the tutor" opens one on a card. */
export default function ReviewPage() {
	const cards = personalLayer.listCards();
	const nodes = personalLayer.nodeList();
	return (
		<ExtPageShell title="Review" description="Flashcards for what you have learned. Ask the tutor when a card does not make sense.">
			<ReviewPanel cards={cards} nodes={nodes} />
			<p className="text-sm">
				<Link href="/practice" className="underline">
					Office hours and exercises
				</Link>
			</p>
		</ExtPageShell>
	);
}
