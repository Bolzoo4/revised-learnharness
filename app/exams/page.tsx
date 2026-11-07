import { ExamsHome } from "@/components/ext/exams-home";
import { ExtPageShell } from "@/components/ext/ext-page-shell";

export const dynamic = "force-dynamic";

/** Exams: the collections of exams and course material (REQ-ex-12). */
export default function ExamsPage() {
	return (
		<ExtPageShell title="Exams" description="Collections of past exams and the material they draw on. Each exam is split into exercises you review before you practise them.">
			<ExamsHome />
		</ExtPageShell>
	);
}
