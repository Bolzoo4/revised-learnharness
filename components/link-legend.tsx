/**
 * The graph's typed-link legend: one swatch per link type PRESENT on the
 * canvas (absent types never appear). Swatch colours are the
 * --graph-link-<type> tokens from app/globals.css, the same table the
 * canvas resolves to hex. Renders nothing when no link is drawn.
 */

import type { LinkType } from "@/src/core";

const LABELS: Record<LinkType, string> = {
	evolution: "Evolution",
	sequence: "Sequence",
	"case-of": "Case of",
	"part-of": "Part of",
	analogy: "Analogy",
	contrast: "Contrast",
};

export function LinkLegend({ types }: { types: readonly LinkType[] }) {
	if (types.length === 0) return null;
	return (
		<ul
			aria-label="Link types"
			data-testid="link-legend"
			className="pointer-events-none flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground"
		>
			{types.map((type) => (
				<li key={type} data-link-type={type} className="flex items-center gap-1.5">
					<span
						aria-hidden="true"
						className="inline-block h-0.5 w-4 rounded-full"
						style={{ background: `var(--graph-link-${type})` }}
					/>
					{LABELS[type]}
				</li>
			))}
		</ul>
	);
}
