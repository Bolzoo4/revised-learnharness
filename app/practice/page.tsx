import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { PracticePanel } from "@/components/ext/practice-panel";
import { listActiveGoals } from "@/src/server";

export const dynamic = "force-dynamic";

export default function PracticePage() {
	const goals = listActiveGoals();
	return (
		<ExtPageShell title="Practice" description="Office hours on a text you paste, and graded exercises for your goals.">
			<PracticePanel goals={goals} />
		</ExtPageShell>
	);
}
