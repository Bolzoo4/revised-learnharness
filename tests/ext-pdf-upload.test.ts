// tests/ext-pdf-upload.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { HttpError } from "../src/server/ext/http-error.ts";
import { stagePdfUpload } from "../src/server/ext/pdf-upload.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-upload-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const PDF = new TextEncoder().encode("%PDF-1.4 a small book");

function upload(parts: Array<{ name: string; value: string | Uint8Array<ArrayBuffer>; filename?: string }>): Request {
	const form = new FormData();
	for (const part of parts) {
		if (part.name === "title") form.append(part.name, part.value as string);
		else {
			const bytes = typeof part.value === "string" ? new TextEncoder().encode(part.value) : part.value;
			form.append(part.name, new File([bytes], part.filename ?? "x.pdf", { type: "application/pdf" }), part.filename ?? "x.pdf");
		}
	}
	return new Request("http://localhost/api/ext/study/documents", { method: "POST", body: form });
}

/** A fresh temp root per test, so leftovers from one test cannot hide another's. */
function tempRoot(): string {
	return fs.mkdtempSync(path.join(ROOT, "root-"));
}
const entries = (dir: string) => fs.readdirSync(dir);

const rejectsWith = (p: Promise<unknown>, status: number, re: RegExp) =>
	assert.rejects(p, (e: unknown) => e instanceof HttpError && e.status === status && re.test(e.message));

describe("stagePdfUpload", () => {
	it("stages a valid PDF under a generated name and deletes it on release", async () => {
		const root = tempRoot();
		const staged = await stagePdfUpload(upload([{ name: "file", value: PDF }]), { tempRoot: root });
		assert.ok(path.resolve(staged.path).startsWith(path.resolve(root) + path.sep));
		assert.deepEqual(new Uint8Array(fs.readFileSync(staged.path)), PDF);
		assert.equal(path.extname(staged.path), ".pdf");
		assert.equal(staged.title, "Uploaded PDF");
		await staged.release();
		assert.equal(fs.existsSync(staged.path), false);
		assert.deepEqual(entries(root), []);
	});

	it("uses the given title, flattened, and refuses one over 200 characters", async () => {
		const root = tempRoot();
		const staged = await stagePdfUpload(upload([{ name: "file", value: PDF }, { name: "title", value: "  Probability\n  Book " }]), { tempRoot: root });
		assert.equal(staged.title, "Probability Book");
		await staged.release();
		await rejectsWith(stagePdfUpload(upload([{ name: "file", value: PDF }, { name: "title", value: "t".repeat(201) }]), { tempRoot: root }), 400, /too long/);
		assert.deepEqual(entries(root), []);
	});

	it("refuses a file that does not start with %PDF- and leaves nothing behind", async () => {
		const root = tempRoot();
		await rejectsWith(stagePdfUpload(upload([{ name: "file", value: "hello" }]), { tempRoot: root }), 400, /not a PDF/);
		await rejectsWith(stagePdfUpload(upload([{ name: "file", value: new TextEncoder().encode("%PDX-1.4") }]), { tempRoot: root }), 400, /not a PDF/);
		assert.deepEqual(entries(root), []);
	});

	it("refuses a PDF over the size limit with a fixed message and stores nothing", async () => {
		const root = tempRoot();
		await rejectsWith(stagePdfUpload(upload([{ name: "file", value: PDF }]), { tempRoot: root, maxBytes: 8 }), 413, /too large \(limit 500 MB\)/);
		assert.deepEqual(entries(root), []);
	});

	it("refuses zero files, two files, and a non-file file field", async () => {
		const root = tempRoot();
		await rejectsWith(stagePdfUpload(upload([{ name: "title", value: "only text" }]), { tempRoot: root }), 400, /exactly one PDF/);
		await rejectsWith(stagePdfUpload(upload([{ name: "file", value: PDF }, { name: "file", value: PDF }]), { tempRoot: root }), 400, /exactly one PDF/);
		const textField = new FormData();
		textField.append("file", "not a file");
		await rejectsWith(stagePdfUpload(new Request("http://localhost/x", { method: "POST", body: textField }), { tempRoot: root }), 400, /exactly one PDF/);
		assert.deepEqual(entries(root), []);
	});

	it("never uses the client's file name: not in the stored path, the title, or a refusal", async () => {
		const root = tempRoot();
		const secret = "/Users/someone/Private Diary.pdf";
		const staged = await stagePdfUpload(upload([{ name: "file", value: PDF, filename: secret }]), { tempRoot: root });
		assert.equal(staged.path.includes("Private"), false);
		assert.equal(staged.path.includes("Users"), false);
		assert.equal(staged.title.includes("Diary"), false);
		await staged.release();
		const refusal = await stagePdfUpload(upload([{ name: "file", value: "nope", filename: secret }]), { tempRoot: root }).then(
			() => "",
			(e: unknown) => (e instanceof Error ? e.message : ""),
		);
		assert.match(refusal, /not a PDF/);
		assert.equal(refusal.includes("Private"), false);
		assert.equal(refusal.includes("Users"), false);
	});

	it("a non-multipart body is a fixed refusal, not a crash", async () => {
		const root = tempRoot();
		const req = new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "garbage" });
		await rejectsWith(stagePdfUpload(req, { tempRoot: root }), 400, /could not be read/);
		assert.deepEqual(entries(root), []);
	});
});
