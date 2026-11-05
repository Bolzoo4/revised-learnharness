import { PracticePanel } from "@/components/ext/practice-panel";
import { listActiveGoals } from "@/src/server";

export const dynamic = "force-dynamic";

export default function PracticePage() {
	const goals = listActiveGoals();
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Practice</h1>
			<PracticePanel goals={goals} />
		</main>
	);
}
