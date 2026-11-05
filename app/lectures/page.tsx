import { LecturesPanel } from "@/components/ext/lectures-panel";

export const dynamic = "force-dynamic";

export default function LecturesPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Lectures</h1>
			<LecturesPanel />
		</main>
	);
}
