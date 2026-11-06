import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { ResearchView } from "@/components/ext/research-view";

export const dynamic = "force-dynamic";

export default function ResearchPage() {
	return (
		<ExtPageShell title="Research">
			<ResearchView />
		</ExtPageShell>
	);
}
