// tests/ext-citation-click.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageAtCaret, pageFromPoint } from "../components/ext/citation-click.ts";

const text = (s: string) => ({ nodeType: 3, textContent: s });
const S = "Defined on (p. 12), proved later.";

describe("page citation under a click (REQ-study-07)", () => {
	it("finds the page from a caret inside the citation", () => {
		const at = S.indexOf("(p. 12)");
		assert.equal(pageAtCaret(text(S), at + 3), 12);
		assert.equal(pageAtCaret(text(S), at), 12);
	});
	it("accepts the caret just after the closing parenthesis", () => {
		assert.equal(pageAtCaret(text(S), S.indexOf("(p. 12)") + "(p. 12)".length), 12);
	});
	it("is null elsewhere, for an element node and for no node", () => {
		assert.equal(pageAtCaret(text(S), 2), null);
		assert.equal(pageAtCaret(text(S), S.length), null);
		assert.equal(pageAtCaret({ nodeType: 1, textContent: S }, 12), null);
		assert.equal(pageAtCaret(null, 0), null);
	});
	it("pageFromPoint reads the caret range of the document, and is null when the browser has none", () => {
		const doc = { caretRangeFromPoint: () => ({ startContainer: text(S), startOffset: 14 }) } as unknown as Document;
		assert.equal(pageFromPoint(doc, 1, 1), 12);
		assert.equal(pageFromPoint({} as Document, 1, 1), null);
		assert.equal(pageFromPoint({ caretRangeFromPoint: () => null } as unknown as Document, 1, 1), null);
	});
});
