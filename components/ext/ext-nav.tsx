"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The learning pages of the extension, as sidebar entries (one list, one place).
 * Labels are plain English and match the sidebar's other rows. "Review" points at
 * the practice page (office hours and graded exercises) and is named after the
 * learner's activity; the upstream "Practice" row creates a practice chat instead.
 */
export const EXT_NAV_ITEMS = [
	{ href: "/practice", label: "Review" },
	{ href: "/lectures", label: "Lectures" },
	{ href: "/study", label: "Study" },
	{ href: "/research", label: "Research" },
	{ href: "/journal", label: "Journal" },
] as const;

/** A page is active on its own path and on the pages below it (/lectures/[id], /study/[documentId]). */
export function isExtNavActive(pathname: string | null, href: string): boolean {
	if (pathname === null) return false;
	return pathname === href || pathname.startsWith(`${href}/`);
}

/** The list itself, driven by the pathname it is given (pure: testable without the router). */
export function ExtNavList({ pathname }: { pathname: string | null }) {
	return (
		<nav aria-label="Learning pages" data-testid="ext-nav" className="mx-3 mb-2 flex flex-col gap-0.5">
			{EXT_NAV_ITEMS.map((item) => {
				const active = isExtNavActive(pathname, item.href);
				return (
					<Link
						key={item.href}
						href={item.href}
						aria-current={active ? "page" : undefined}
						data-testid={`ext-nav-${item.label.toLowerCase()}`}
						className={cn(
							"flex items-center rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
							active ? "bg-accent text-foreground" : "text-muted-foreground",
						)}
					>
						{item.label}
					</Link>
				);
			})}
		</nav>
	);
}

/** The sidebar entry: reads the current pathname and renders the list. */
export function ExtNav() {
	return <ExtNavList pathname={usePathname()} />;
}
