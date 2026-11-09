// The client helper: attachments are never lost to a failed call.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { importPaths } from "../components/ext/workspace-import.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const stub = (impl: () => Promise<Response>) => { globalThis.fetch = impl as unknown as typeof fetch; };

describe("importPaths", () => {
	it("returns the server's copies, in order, with the reasons for the files it could not copy", async () => {
		stub(async () => new Response(JSON.stringify({ paths: ["/ws/a.pdf", "/x/b.pdf"], errors: ["b.pdf could not be copied."] })));
		assert.deepEqual(await importPaths(["/x/a.pdf", "/x/b.pdf"]), { paths: ["/ws/a.pdf", "/x/b.pdf"], errors: ["b.pdf could not be copied."] });
	});
	it("hands the original paths back on a network error, an error status, or a malformed answer", async () => {
		const original = ["/x/a.pdf", "/x/b.pdf"];
		stub(async () => { throw new Error("offline"); });
		assert.deepEqual((await importPaths(original)).paths, original);
		stub(async () => new Response("{}", { status: 500 }));
		assert.deepEqual((await importPaths(original)).paths, original);
		stub(async () => new Response(JSON.stringify({ paths: ["/ws/only-one.pdf"] })));
		assert.deepEqual((await importPaths(original)).paths, original, "a different count is refused");
		stub(async () => new Response(JSON.stringify({ paths: [1, 2] })));
		assert.deepEqual((await importPaths(original)).paths, original);
	});
});
