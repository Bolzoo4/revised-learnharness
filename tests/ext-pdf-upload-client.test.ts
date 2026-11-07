// tests/ext-pdf-upload-client.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildPdfUploadForm,
	checkPdfFile,
	failureText,
	MAX_PDF_UPLOAD_BYTES,
	pickPdf,
	titleFromFileName,
	uploadPdf,
} from "../components/ext/pdf-upload.ts";

const pdf = (name = "book.pdf", size = 1000) => ({ name, size, type: "application/pdf" });

describe("checkPdfFile", () => {
	it("accepts a PDF by type or by extension, in any case", () => {
		assert.equal(checkPdfFile(pdf()), null);
		assert.equal(checkPdfFile({ name: "BOOK.PDF", size: 5, type: "" }), null);
	});
	it("refuses anything that is not a PDF with the fixed message", () => {
		assert.equal(checkPdfFile({ name: "notes.txt", size: 5, type: "text/plain" }), "Choose a PDF file.");
	});
	it("refuses an empty file", () => {
		assert.equal(checkPdfFile(pdf("a.pdf", 0)), "That file is empty.");
	});
	it("refuses a file over 500 MB and accepts one exactly at the limit", () => {
		assert.equal(MAX_PDF_UPLOAD_BYTES, 500 * 1024 * 1024);
		assert.equal(checkPdfFile(pdf("a.pdf", MAX_PDF_UPLOAD_BYTES)), null);
		assert.equal(checkPdfFile(pdf("a.pdf", MAX_PDF_UPLOAD_BYTES + 1)), "That PDF is too large (limit 500 MB).");
	});
});

describe("pickPdf", () => {
	it("returns the one checked file", () => {
		const file = new File(["%PDF-1.4 x"], "a.pdf", { type: "application/pdf" });
		const pick = pickPdf([file]);
		assert.equal(pick.ok && pick.file, file);
	});
	it("refuses no file and more than one file", () => {
		assert.deepEqual(pickPdf([]), { ok: false, error: "No file was chosen." });
		const a = new File(["%PDF-"], "a.pdf", { type: "application/pdf" });
		assert.deepEqual(pickPdf([a, a]), { ok: false, error: "Choose one PDF at a time." });
	});
	it("refuses a single non-PDF file", () => {
		const txt = new File(["hi"], "a.txt", { type: "text/plain" });
		assert.deepEqual(pickPdf([txt]), { ok: false, error: "Choose a PDF file." });
	});
});

describe("buildPdfUploadForm", () => {
	it("sends the file under a fixed name, never the client's name", () => {
		const file = new File(["%PDF-1.4"], "/Users/someone/Private Diary.pdf", { type: "application/pdf" });
		const form = buildPdfUploadForm(file);
		const sent = form.get("file") as File;
		assert.equal(sent.name, "upload.pdf");
		assert.equal(form.has("title"), false);
	});
	it("adds a trimmed title only when one was typed", () => {
		const file = new File(["%PDF-"], "a.pdf", { type: "application/pdf" });
		assert.equal(buildPdfUploadForm(file, "  Probability ").get("title"), "Probability");
		assert.equal(buildPdfUploadForm(file, "   ").has("title"), false);
	});
});

describe("uploadPdf", () => {
	it("posts multipart form data to the given URL", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response("{}", { status: 201 });
		}) as typeof fetch;
		const res = await uploadPdf(fakeFetch, "/api/ext/study/documents", new File(["%PDF-"], "a.pdf"), "Title");
		assert.equal(res.status, 201);
		assert.equal(calls[0]!.url, "/api/ext/study/documents");
		assert.equal(calls[0]!.init.method, "POST");
		const body = calls[0]!.init.body as FormData;
		assert.ok(body instanceof FormData);
		assert.equal(body.get("title"), "Title");
	});
});

describe("failureText", () => {
	it("shows the server's fixed error text, else the fallback", async () => {
		assert.equal(await failureText(new Response(JSON.stringify({ error: "that PDF has no pages" }), { status: 422 }), "fallback"), "that PDF has no pages");
		assert.equal(await failureText(new Response("<html>", { status: 500 }), "fallback"), "fallback");
		assert.equal(await failureText(new Response(JSON.stringify({ error: "" }), { status: 400 }), "fallback"), "fallback");
	});
});

describe("titleFromFileName", () => {
		it("titleFromFileName: the file name without folders and .pdf", () => {
		assert.equal(titleFromFileName("Deep Learning Theory.pdf"), "Deep Learning Theory");
		assert.equal(titleFromFileName("C:\\Books\\My Book.PDF"), "My Book");
		assert.equal(titleFromFileName("/Users/x/Books/ml_notes.pdf"), "ml_notes");
	});
		it("titleFromFileName: one line, bounded, no control characters", () => {
		assert.equal(titleFromFileName("a\n\tb\u0000c  d.pdf"), "a b c d");
		assert.equal(Array.from(titleFromFileName("x".repeat(500) + ".pdf")).length, 200);
		assert.equal(titleFromFileName(".pdf"), "");
		assert.equal(titleFromFileName(""), "");
	});
});
