// tests/chat-speech.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { speechText } from "../src/core/chat-speech.ts";

const text = (value: string) => ({ type: "text", text: value });

describe("speechText: which parts are read", () => {
	it("joins the text parts of an assistant message in order", () => {
		assert.equal(speechText([text("First sentence."), text("Second sentence.")]), "First sentence. Second sentence.");
	});

	it("ignores tool calls and reasoning, which are not prose", () => {
		const parts = [
			{ type: "thinking", thinking: "private reasoning" },
			text("The answer is 4."),
			{ type: "toolCall", id: "t1", name: "ask", arguments: { question: "Why?" } },
		];
		assert.equal(speechText(parts), "The answer is 4.");
	});

	it("returns an empty string when nothing is speakable", () => {
		assert.equal(speechText([{ type: "toolCall", id: "t1", name: "ask", arguments: {} }]), "");
		assert.equal(speechText([text("   \n  ")]), "");
		assert.equal(speechText([]), "");
	});
});

describe("speechText: markup that is removed", () => {
	it("removes fenced code blocks entirely, with their language line", () => {
		const md = "Look at this:\n```python\nprint('hello')\n```\nand then this.";
		assert.equal(speechText([text(md)]), "Look at this: and then this.");
	});

	it("removes tilde-fenced code blocks too", () => {
		assert.equal(speechText([text("Before.\n~~~\nx = 1\n~~~\nAfter.")]), "Before. After.");
	});

	it("keeps the words of inline code and drops the backticks", () => {
		assert.equal(speechText([text("Use `Math.max` to get the `largest` value.")]), "Use Math.max to get the largest value.");
	});

	it("drops the heading marks and keeps the heading words", () => {
		assert.equal(speechText([text("## Limits\nThe limit exists.")]), "Limits The limit exists.");
	});

	it("drops the pipes and the separator row of a table and keeps the cell words", () => {
		const md = "| Set | Closed |\n|---|:---:|\n| A | yes |";
		assert.equal(speechText([text(md)]), "Set Closed A yes");
	});

	it("drops emphasis marks and keeps the emphasised words", () => {
		assert.equal(speechText([text("This is **very** important and *also* __this__ and _that_.")]), "This is very important and also this and that.");
	});

	it("keeps underscores inside words", () => {
		assert.equal(speechText([text("Set snake_case_name here.")]), "Set snake_case_name here.");
	});

	it("reads a markdown link as its label, not its address", () => {
		assert.equal(speechText([text("See [the notes](https://example.com/notes) for more.")]), "See the notes for more.");
	});

	it("reads a node link as its label, through stripNodeLinks", () => {
		assert.equal(speechText([text("The [[n_abc123|compactness]] theorem holds.")]), "The compactness theorem holds.");
	});

	it("collapses runs of whitespace, including line breaks, to single spaces", () => {
		assert.equal(speechText([text("One\n\n\n   two\tthree")]), "One two three");
	});
});
