import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { LecturesPanel } from "@/components/ext/lectures-panel";

export const dynamic = "force-dynamic";

export default function LecturesPage() {
	return (
		<ExtPageShell title="Lectures" description="Each book you add as a PDF is split into chapters, and each chapter becomes a lecture.">
			<LecturesPanel />
		</ExtPageShell>
	);
}
