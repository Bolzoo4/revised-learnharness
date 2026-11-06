import { ResearchView } from "@/components/ext/research-view";

export const dynamic = "force-dynamic";

export default function ResearchPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Research</h1>
			<ResearchView />
		</main>
	);
}
