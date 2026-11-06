import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar";

/**
 * The shell of every learning page of the extension: the upstream TopBar
 * (drag band, the sidebar reopen toggle with its macOS traffic-light gutter)
 * carries the page title, and the body sits under it with one padding and one
 * max width. The shell is exactly one viewport tall and only the body scrolls,
 * so the sidebar never moves with the page. `wide` widens the column (a lecture page); `fill` gives the body
 * the whole remaining height (the study session's split view) and drops the
 * padding. The title is plain UI type: the serif title register belongs to
 * chat sessions (components/top-bar.tsx, the title law).
 */
export function ExtPageShell({
	title,
	description,
	wide = false,
	fill = false,
	children,
}: {
	title: string;
	description?: string;
	wide?: boolean;
	fill?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex h-dvh min-w-0 flex-col">
			<TopBar>
				<h1 className="min-w-0 truncate text-base font-medium">{title}</h1>
			</TopBar>
			{fill ? (
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<main className={`mx-auto flex w-full ${wide ? "max-w-5xl" : "max-w-3xl"} flex-col gap-4 p-6`}>
						{description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
						{children}
					</main>
				</div>
			)}
		</div>
	);
}
