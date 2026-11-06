// tests/ext-pdf-upload-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-upload-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const studyDocuments = await import("../app/api/ext/study/documents/route.ts");
const lectures = await import("../app/api/ext/lectures/route.ts");
const { EXT_PATHS } = await import("../src/store/ext/paths.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const SAMPLE = Uint8Array.from(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));
const tempDir = path.join(EXT_PATHS.dir, "tmp");
/** Upload directories still present in the temp area (none should survive a request). */
const leftovers = () => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []);

function multipart(url: string, parts: Array<{ name: string; value: string | Uint8Array<ArrayBuffer>; filename?: string }>): Request {
	const form = new FormData();
	for (const part of parts) {
		if (part.name === "title") form.append(part.name, part.value as string);
		else {
			const bytes = typeof part.value === "string" ? new TextEncoder().encode(part.value) : part.value;
			form.append(part.name, new File([bytes], part.filename ?? "book.pdf", { type: "application/pdf" }), part.filename ?? "book.pdf");
		}
	}
	return new Request(`http://localhost${url}`, { method: "POST", body: form });
}

describe("POST /api/ext/study/documents (multipart)", () => {
	it("registers a valid PDF with the default title and deletes the staged copy", async () => {
		const res = await studyDocuments.POST(multipart("/api/ext/study/documents", [{ name: "file", value: SAMPLE, filename: "Diary.pdf" }]));
		assert.equal(res.status, 201);
		const doc = (await res.json()) as { title: string; pageCount: number };
		assert.equal(doc.title, "Uploaded PDF");
		assert.ok(doc.pageCount > 0);
		assert.deepEqual(leftovers(), []);
	});

	it("a non-PDF is refused with a fixed message and nothing is left behind", async () => {
		const res = await studyDocuments.POST(multipart("/api/ext/study/documents", [{ name: "file", value: "plain text", filename: "Secret.pdf" }]));
		assert.equal(res.status, 400);
		const text = await res.text();
		assert.match(text, /not a PDF/);
		assert.equal(text.includes("Secret"), false);
		assert.deepEqual(leftovers(), []);
	});

	it("a PDF header with unreadable content is refused and its staged copy is deleted", async () => {
		const broken = new TextEncoder().encode("%PDF-1.4 this is not a real document");
		const res = await studyDocuments.POST(multipart("/api/ext/study/documents", [{ name: "file", value: broken, filename: "broken.pdf" }]));
		assert.equal(res.status, 422);
		assert.equal((await res.text()).includes("broken"), false);
		assert.deepEqual(leftovers(), []);
	});

	it("the JSON path still answers its own refusal for a missing path", async () => {
		const res = await studyDocuments.POST(new Request("http://localhost/api/ext/study/documents", { method: "POST", body: JSON.stringify({}) }));
		assert.equal(res.status, 400);
	});
});

describe("POST /api/ext/lectures (multipart)", () => {
	it("a non-PDF is refused before any ingest starts and nothing is left behind", async () => {
		const res = await lectures.POST(multipart("/api/ext/lectures", [{ name: "file", value: "not a pdf", filename: "Book.pdf" }]));
		assert.equal(res.status, 400);
		assert.equal((await res.text()).includes("Book"), false);
		assert.deepEqual(leftovers(), []);
	});

	it("more than one file is refused", async () => {
		const res = await lectures.POST(multipart("/api/ext/lectures", [{ name: "file", value: SAMPLE }, { name: "file", value: SAMPLE }]));
		assert.equal(res.status, 400);
		assert.deepEqual(leftovers(), []);
	});
});
