import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { StudyHome } from "@/components/ext/study-home";
import { studyService } from "@/src/server";

export const dynamic = "force-dynamic";

export default function StudyPage() {
	return (
		<ExtPageShell title="Study" description="Read your own PDFs with a tutor beside them. What you learn from a PDF is checked against it.">
			<StudyHome initial={studyService.listDocuments()} />
		</ExtPageShell>
	);
}
