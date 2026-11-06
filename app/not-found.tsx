import Link from "next/link";

/**
 * The 404 page. Next's default has no way back, which strands the learner in the
 * desktop app (there is no browser back button): a short message and a link home.
 */
export default function NotFound() {
	return (
		<main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
			<h1 className="text-lg font-medium">Page not found</h1>
			<p className="text-sm text-muted-foreground">This page does not exist, or what it pointed to is gone.</p>
			<Link href="/" className="rounded border px-3 py-1 text-sm hover:bg-accent">
				Back to the home
			</Link>
		</main>
	);
}
