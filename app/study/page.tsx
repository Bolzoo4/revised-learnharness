import { StudyHome } from "@/components/ext/study-home";
import { studyService } from "@/src/server";

export const dynamic = "force-dynamic";

export default function StudyPage() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
			<h1 className="text-xl font-medium">Study</h1>
			<StudyHome initial={studyService.listDocuments()} />
		</main>
	);
}
