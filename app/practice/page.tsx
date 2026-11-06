import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { PracticePanel } from "@/components/ext/practice-panel";
import { listActiveGoals } from "@/src/server";

export const dynamic = "force-dynamic";

export default function PracticePage() {
	const goals = listActiveGoals();
	return (
		<ExtPageShell title="Practice" description="Start a daily review session, or open office hours on a text you paste.">
			<PracticePanel goals={goals} />
		</ExtPageShell>
	);
}
