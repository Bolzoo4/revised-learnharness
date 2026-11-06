import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { JournalView } from "@/components/ext/journal-view";

export const dynamic = "force-dynamic";

export default function JournalPage() {
	return (
		<ExtPageShell title="Journal" description="A debrief of each session as it ends, and a weekly summary of your progress.">
			<JournalView />
		</ExtPageShell>
	);
}
