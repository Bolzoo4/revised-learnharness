// tests/helpers/outline-pdf.ts
/** A valid N-page text PDF (ASCII only, one line per page) with an optional bookmark outline. */
export function buildOutlinePdf(pageTexts: string[], outline: { title: string; page: number }[] = []): Uint8Array {
	const n = pageTexts.length;
	const fontId = 3 + n * 2;
	const rootId = fontId + 1;
	const objects: string[] = [];
	objects[1] = `<</Type/Catalog/Pages 2 0 R${outline.length > 0 ? ` /Outlines ${rootId} 0 R` : ""}>>`;
	objects[2] = `<</Type/Pages/Kids[${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}]/Count ${n}>>`;
	pageTexts.forEach((text, i) => {
		const pageId = 3 + i * 2;
		const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
		objects[pageId] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${pageId + 1} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
		objects[pageId + 1] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
	});
	objects[fontId] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
	if (outline.length > 0) {
		const first = rootId + 1;
		const last = rootId + outline.length;
		objects[rootId] = `<</Type/Outlines/First ${first} 0 R/Last ${last} 0 R/Count ${outline.length}>>`;
		outline.forEach((o, i) => {
			const id = rootId + 1 + i;
			const links = `${i > 0 ? `/Prev ${id - 1} 0 R` : ""}${i + 1 < outline.length ? `/Next ${id + 1} 0 R` : ""}`;
			objects[id] = `<</Title(${o.title})/Parent ${rootId} 0 R${links}/Dest[${3 + (o.page - 1) * 2} 0 R/Fit]>>`;
		});
	}
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = pdf.length;
		pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
	return new Uint8Array(Buffer.from(pdf, "latin1"));
}
