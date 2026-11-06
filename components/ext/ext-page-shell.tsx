import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar";

/**
 * The shell of every learning page of the extension: the upstream TopBar
 * (drag band, the sidebar reopen toggle with its macOS traffic-light gutter)
 * carries the page title, and the body sits under it with one padding and one
 * max width. `wide` widens the column (a lecture page); `fill` gives the body
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
		<div className={`flex min-w-0 flex-col ${fill ? "h-dvh" : "min-h-dvh"}`}>
			<TopBar>
				<h1 className="min-w-0 truncate text-base font-medium">{title}</h1>
			</TopBar>
			{fill ? (
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
			) : (
				<main className={`mx-auto flex w-full ${wide ? "max-w-5xl" : "max-w-3xl"} flex-col gap-4 p-6`}>
					{description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
					{children}
				</main>
			)}
		</div>
	);
}
