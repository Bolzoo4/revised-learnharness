import Link from "next/link";
import { notFound } from "next/navigation";
import { LectureView } from "@/components/ext/lecture-view";
import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function LecturePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const lecture = lectureService.getLecture(id);
	if (!lecture) notFound();
	return (
		<main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
			<div>
				<Link className="text-sm underline" href="/lectures">All lectures</Link>
				<h1 className="text-xl font-medium">{lecture.bookTitle} · ch. {lecture.chapter.index}: {lecture.title}</h1>
			</div>
			<LectureView lecture={lecture} />
		</main>
	);
}
