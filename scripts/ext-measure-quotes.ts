// scripts/ext-measure-quotes.ts
/**
 * Usage: npx tsx scripts/ext-measure-quotes.ts <pdf> [--samples 400]
 * Realistic proxy for quote loss. In real use the verifier quotes text it read through the SAME
 * pdfExtract pipeline, so windows are taken from the pdfExtract output itself and then perturbed
 * the way a model re-typing a quotation does (whitespace, typographic characters, spacing around
 * math symbols, joined hyphenation). Reports the exact-match acceptance per perturbation and
 * separately for prose-only and math-heavy windows. Nothing is written to disk.
 */
import { pdfExtract } from "../src/agent/subagents/pdf-ops.ts";
import { checkQuote } from "../src/core/ext/quote.ts";

const args = process.argv.slice(2);
const pdf = args[0];
if (pdf === undefined) throw new Error("usage: ext-measure-quotes.ts <pdf> [--samples N]");
const i = args.indexOf("--samples");
const samples = i >= 0 ? Number(args[i + 1]) : 400;

const snapshot = (await pdfExtract(pdf, "all")).replace(/^--- Page \d+ ---$/gm, "");

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

/** n consecutive whitespace-separated tokens, original separators (newlines included) preserved. */
function windows(text: string, n: number, count: number): string[] {
	const tokens = [...text.matchAll(/\S+/g)];
	const out: string[] = [];
	for (let k = 0; k < count && tokens.length > n; k++) {
		const s = Math.floor(rand() * (tokens.length - n));
		const first = tokens[s]!;
		const last = tokens[s + n - 1]!;
		out.push(text.slice(first.index, last.index! + last[0].length));
	}
	return out;
}

const MATH = /[=+<>≤≥≠≈×·∈∉⊂⊆∪∩∑∏∫→⇒⇔∀∃±÷^_|/*()[\]{}]|(?<=\w)-(?=\w)/g;
const isMathHeavy = (w: string) => (w.match(/[=+<>≤≥≠≈×·∈∉⊂⊆∪∩∑∏∫→⇒⇔∀∃±÷^_|\\{}$]/g) ?? []).length >= 2;

const perturb: Record<string, (w: string) => string> = {
	verbatim: (w) => w,
	"whitespace collapsed": (w) => w.replace(/\s+/g, " "),
	"typographic chars": (w) => w.replace(/'/g, "’").replace(/"([^"]*)"/g, "“$1”").replace(/ - /g, " – "),
	"hyphen line-break joined": (w) => w.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2"),
	"spaces removed around math symbols": (w) => w.replace(/\s*([=+<>≤≥≠≈×·∈∉⊂⊆∪∩→⇒⇔±÷^_|])\s*/g, "$1").replace(/\s+/g, " "),
	"spaces inserted around math symbols": (w) => w.replace(/\s*([=+<>≤≥≠≈×·∈∉⊂⊆∪∩→⇒⇔±÷])\s*/g, " $1 ").replace(/\s+/g, " "),
	"combined (ws+typo+random respacing)": (w) => {
		let s = perturb["whitespace collapsed"]!(w);
		s = perturb["typographic chars"]!(s);
		return perturb[rand() < 0.5 ? "spaces removed around math symbols" : "spaces inserted around math symbols"]!(s);
	},
};

const all = windows(snapshot, 8, samples);
const classes: Record<string, string[]> = {
	all,
	"prose-only": all.filter((w) => !isMathHeavy(w)),
	"math-heavy": all.filter(isMathHeavy),
};
void MATH;

const misses: string[] = [];
for (const [cls, ws] of Object.entries(classes)) {
	console.log(`\n== ${cls} (${ws.length} windows)`);
	for (const [name, fn] of Object.entries(perturb)) {
		let ok = 0;
		let n = 0;
		for (const w of ws) {
			const q = fn(w);
			const r = checkQuote(snapshot, q);
			if (r === "quote_too_short") continue;
			n++;
			if (r === "ok") ok++;
			else if (cls === "all" && name.startsWith("combined")) misses.push(q);
		}
		console.log(`  ${name.padEnd(40)} ${ok}/${n} = ${(ok / Math.max(1, n)).toFixed(3)}`);
	}
}
console.log("\nsample misses (combined):");
for (const m of misses.slice(0, 8)) console.log(`  - ${m.replace(/\n/g, "\\n")}`);
