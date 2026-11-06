import Link from "next/link";
import { notFound } from "next/navigation";
import { ExtPageShell } from "@/components/ext/ext-page-shell";
import { LectureView } from "@/components/ext/lecture-view";
import { exercisesOf } from "@/src/core";
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function LecturePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const lecture = lectureService.getLecture(id);
	if (!lecture) notFound();
	return (
		<ExtPageShell title={`${lecture.bookTitle} · ch. ${lecture.chapter.index}: ${lecture.title}`} wide>
			<Link className="text-sm underline" href="/lectures">All lectures</Link>
			<LectureView lecture={lecture} exercises={exercisesOf(lecture)} />
		</ExtPageShell>
	);
}
