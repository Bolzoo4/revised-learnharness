import { notFound } from "next/navigation";
import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { StudyView } from "@/components/ext/study-view";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, StudyError, studyService, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function StudyDocumentPage({
	params,
	searchParams,
}: {
	params: Promise<{ documentId: string }>;
	searchParams: Promise<{ page?: string }>;
}) {
	const [{ documentId }, { page }] = await Promise.all([params, searchParams]);
	let opened;
	try {
		opened = await studyService.open(documentId);
	} catch (e) {
		if (e instanceof StudyError && e.status === 404) notFound();
		throw e;
	}
	const chat = getChat(opened.chatId);
	if (!chat) notFound();
	const wanted = Number(page);
	const start = Number.isInteger(wanted) && wanted >= 1 && wanted <= opened.document.pageCount ? wanted : opened.page;
	return (
		<ExtPageShell title={opened.document.title} fill>
			<StudyView
				document={{ id: opened.document.id, title: opened.document.title, pageCount: opened.document.pageCount }}
				startPage={start}
				chat={{
					chatId: chat.id,
					title: chat.title,
					initialMessages: chat.messages,
					initialError: turnFailure(chat.id),
					initialConfigured: slotsConfigured(readSettingsRecord()?.models),
					initiallyInFlight: isTurnRunning(chat.id),
					initiallyCompacting: compactionInFlight(chat.id),
				}}
			/>
		</ExtPageShell>
	);
}
