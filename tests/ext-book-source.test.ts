import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSourceLibrary } from "../src/core/ext/sources.ts";
import { registerBookAsPrimary } from "../src/core/ext/lecture/book-source.ts";
import { memSourcesStore } from "./helpers/ext-fakes.ts";

describe("registerBookAsPrimary (REQ-lec-02)", () => {
	it("adds the book as an active primary pdf source", () => {
		const lib = createSourceLibrary(memSourcesStore());
		registerBookAsPrimary(lib, "/books/prob.pdf", "Probability 1");
		const [e] = lib.list();
		assert.deepEqual([e!.kind, e!.locator, e!.tier, e!.status, e!.label, e!.addedBy], ["pdf", "/books/prob.pdf", "primary", "active", "Probability 1", "user"]);
	});
	it("is idempotent", () => {
		const lib = createSourceLibrary(memSourcesStore());
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		assert.equal(lib.list().length, 1);
	});
	it("promotes an existing proposed secondary entry", () => {
		const lib = createSourceLibrary(memSourcesStore());
		lib.propose([{ kind: "pdf", locator: "/books/prob.pdf", label: "P" }]);
		assert.equal(lib.list()[0]!.status, "proposed");
		registerBookAsPrimary(lib, "/books/prob.pdf", "P");
		assert.deepEqual([lib.list()[0]!.status, lib.list()[0]!.tier], ["active", "primary"]);
	});
});
