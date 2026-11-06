import { JournalView } from "@/components/ext/journal-view";

export const dynamic = "force-dynamic";

export default function JournalPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Journal</h1>
			<JournalView />
		</main>
	);
}
