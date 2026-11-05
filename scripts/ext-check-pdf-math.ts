// scripts/ext-check-pdf-math.ts
/**
 * Environment check for lecture generation (child spec 4): is the math in a
 * book's extracted text usable? Lectures and chapter graphs are built from
 * exactly this text (pdfExtract, the pipeline readChapterText uses).
 *
 * Usage: npx tsx scripts/ext-check-pdf-math.ts <pdf> <pages>      e.g. 10-14
 * Prints the damage counters and the lines with the most mathematical
 * content; read the sample yourself: the counters catch encoding damage,
 * only your eyes catch a garbled formula. Exit 1 when damage exceeds 1%.
 * Nothing is written to disk.
 */
import { pdfExtract } from "../src/agent/subagents/pdf-ops.ts";

const [pdf, pages] = process.argv.slice(2);
if (pdf === undefined || pages === undefined) throw new Error("usage: ext-check-pdf-math.ts <pdf> <pages, e.g. 10-14>");

const text = await pdfExtract(pdf, pages);
const visible = text.replace(/\s/g, "");
const count = (re: RegExp): number => (text.match(re) ?? []).length;
const damage = {
	replacementChars: count(/�/g),
	privateUse: count(/[-]/g),
	cidTokens: count(/\(cid:\d+\)/g),
	controlChars: count(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g),
};
const damaged = damage.replacementChars + damage.privateUse + damage.cidTokens * 7 + damage.controlChars;
const MATH = /[∑∏∫∂∇∞≤≥≠≈∈∉⊂⊆∪∩∀∃→⇒⇔±×÷√αβγδεθλμπσφωΩΣΔ]|\\[a-zA-Z]+|\$[^$]+\$|[_^]\{/g;
const mathy = text
	.split("\n")
	.map((line) => ({ line, score: (line.match(MATH) ?? []).length }))
	.filter((x) => x.score > 0)
	.sort((a, b) => b.score - a.score)
	.slice(0, 15);

const ratio = visible.length === 0 ? 1 : damaged / visible.length;
console.log(JSON.stringify({ pdf, pages, chars: visible.length, ...damage, damageRatio: Number(ratio.toFixed(4)), mathLines: mathy.length }, null, 2));
console.log("\nMost mathematical lines (read them):");
for (const { line } of mathy) console.log(`  ${line.trim().slice(0, 160)}`);
process.exit(visible.length > 0 && ratio <= 0.01 ? 0 : 1);
