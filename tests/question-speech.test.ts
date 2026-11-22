// tests/question-speech.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenForm } from "../src/core/question-speech.ts";

const askPart = (input: unknown, state = "input-available") => ({ type: "tool-ask_user_question", state, input });
const quizPart = (input: unknown, state = "input-available") => ({ type: "tool-quiz", state, input });

const quizInput = (overrides: Record<string, unknown> = {}) => ({
	type: "check",
	nodeId: "n1",
	question: "Which planet is closest to the Sun?",
	options: [{ label: "Mercury", value: "key-a" }, { label: "Venus", value: "key-b" }],
	explanation: "SECRET-EXPLANATION-XYZ",
	correctAnswer: "key-a",
	...overrides,
});

describe("spokenForm: which parts are read", () => {
	it("returns null for a part that is not a tool part", () => {
		assert.equal(spokenForm({ type: "text", text: "hello" }), null);
	});

	it("returns null for a tool part that is not ask or quiz", () => {
		assert.equal(spokenForm({ type: "tool-bash", state: "input-available", input: { command: "ls" } }), null);
	});

	it("returns null for a question that is not pending", () => {
		assert.equal(spokenForm(askPart({ question: "Why?" }, "output-available")), null);
		assert.equal(spokenForm(quizPart(quizInput(), "input-streaming")), null);
	});

	it("returns null for a malformed question (the dock shows the fallback, nothing is spoken)", () => {
		assert.equal(spokenForm(askPart({ question: "Pick", options: [{ label: "" }, { label: "x" }] })), null);
	});
});

describe("spokenForm: open ask", () => {
	it("reads the question then the English closing prompt", () => {
		const out = spokenForm(askPart({ question: "What did you find confusing about the proof?" }));
		assert.ok(out);
		assert.equal(out.text, "What did you find confusing about the proof? Answer in your own words.");
		assert.deepEqual(out.options, []);
		assert.equal(out.language, "en");
	});

	it("uses the Italian closing prompt when the question is Italian", () => {
		const out = spokenForm(askPart({ question: "Che cosa sono le cellule e come si dividono per la mitosi?" }));
		assert.ok(out);
		assert.equal(out.language, "it");
		assert.equal(out.text, "Che cosa sono le cellule e come si dividono per la mitosi? Rispondi con parole tue.");
	});
});

describe("spokenForm: option questions", () => {
	it("reads each option with its letter, then the closing prompt", () => {
		const out = spokenForm(
			askPart({
				question: "Which planet is closest to the Sun?",
				options: [{ label: "Mercury" }, { label: "Venus" }, { label: "Mars" }],
			}),
		);
		assert.ok(out);
		assert.equal(
			out.text,
			"Which planet is closest to the Sun? A: Mercury. B: Venus. C: Mars. Answer with the letter or the words.",
		);
		assert.deepEqual(out.options, [
			{ letter: "A", label: "Mercury", value: "Mercury" },
			{ letter: "B", label: "Venus", value: "Venus" },
			{ letter: "C", label: "Mars", value: "Mars" },
		]);
	});

	it("uses the Italian closing prompt when the question and labels are Italian", () => {
		const out = spokenForm(
			askPart({
				question: "Quale pianeta è più vicino al Sole, e come si chiama la sua orbita, e perché la Terra non lo è?",
				options: [{ label: "Mercurio" }, { label: "Venere" }],
			}),
		);
		assert.ok(out);
		assert.equal(out.language, "it");
		assert.match(out.text, /A: Mercurio\. B: Venere\. Rispondi con la lettera o con le parole\.$/);
	});

	it("reads an ask option description after its label", () => {
		const out = spokenForm(
			askPart({
				question: "Which tool do you prefer?",
				options: [
					{ label: "Flashcards", description: "Short prompts you answer from memory" },
					{ label: "Essays", description: "Longer written answers." },
				],
			}),
		);
		assert.ok(out);
		assert.match(out.text, /^Which tool do you prefer\? A: Flashcards\. Short prompts you answer from memory\. B: Essays\. Longer written answers\. /);
	});

	it("never reads a quiz option's extra fields, correct answer or explanation", () => {
		const out = spokenForm(quizPart(quizInput()));
		assert.ok(out);
		assert.ok(!out.text.includes("SECRET-EXPLANATION-XYZ"), "explanation must not be spoken");
		assert.ok(!out.text.includes("key-a"), "the correct value must not be spoken");
		assert.ok(!out.text.includes("key-b"), "a value must not be spoken");
		assert.equal(
			out.text,
			"Which planet is closest to the Sun? A: Mercury. B: Venus. Answer with the letter or the words.",
		);
	});

	it("never adds a description to quiz options even if the input carries one", () => {
		const out = spokenForm(
			quizPart(
				quizInput({
					options: [{ label: "Mercury", value: "Mercury", description: "closer than the rest" }, { label: "Venus", value: "Venus" }],
					correctAnswer: "Mercury",
				}),
			),
		);
		assert.ok(out);
		assert.ok(!out.text.includes("closer than the rest"));
	});

	it("reads options given as a JSON string (the parseOptionsIfString wobble)", () => {
		const out = spokenForm(
			askPart({
				question: "Which planet is closest to the Sun?",
				options: JSON.stringify([{ label: "Mercury" }, { label: "Venus" }]),
			}),
		);
		assert.ok(out);
		assert.deepEqual(
			out.options.map((o) => o.label),
			["Mercury", "Venus"],
		);
	});

	it("reads more than six options in full", () => {
		const labels = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
		const out = spokenForm(askPart({ question: "Pick one", options: labels.map((label) => ({ label })) }));
		assert.ok(out);
		assert.equal(out.options.length, 8);
		assert.equal(out.options[7]!.letter, "H");
		assert.ok(out.text.includes("H: Eight."));
	});

	it("reads a multi-select ask as several letters and marks it multi", () => {
		const out = spokenForm(
			askPart({
				question: "Which of these apply?",
				multiSelect: true,
				options: [{ label: "Mercury" }, { label: "Venus" }],
			}),
		);
		assert.ok(out);
		assert.equal(out.multi, true);
		assert.ok(out.text.endsWith("Answer with one or more letters."));
	});

	it("does not mark a single-select ask as multi", () => {
		const out = spokenForm(askPart({ question: "Which?", options: [{ label: "Mercury" }, { label: "Venus" }] }));
		assert.ok(out);
		assert.equal(out.multi, undefined);
	});

	it("does not repeat a terminal period when a label already ends in one", () => {
		const out = spokenForm(askPart({ question: "Pick", options: [{ label: "Mercury." }, { label: "Venus" }] }));
		assert.ok(out);
		assert.ok(out.text.includes("A: Mercury. B: Venus."));
		assert.ok(!out.text.includes(".."));
	});
});

describe("spokenForm: language", () => {
	it("is English when the language is unknown (short labels, no clear stopwords)", () => {
		const out = spokenForm(askPart({ question: "Pick", options: [{ label: "Mars" }, { label: "Jupiter" }] }));
		assert.ok(out);
		assert.equal(out.language, "en");
	});

	it("is English for an English question", () => {
		const out = spokenForm(
			askPart({
				question: "What is the capital of France and what is the river that flows through it?",
			}),
		);
		assert.ok(out);
		assert.equal(out.language, "en");
	});
});

describe("spokenForm: language hint", () => {
	const shortItalian = { question: "Scegli la risposta?", options: [{ label: "Mars" }, { label: "Jupiter" }] };

	it("uses the hint when the question's own language is unknown", () => {
		const out = spokenForm(askPart(shortItalian), { languageHint: "it" });
		assert.ok(out);
		assert.equal(out.language, "it");
		assert.match(out.text, /A: Mars/);
	});

	it("without a hint an unknown language is still English", () => {
		const out = spokenForm(askPart(shortItalian));
		assert.ok(out);
		assert.equal(out.language, "en");
	});

	it("a clear language of the question wins over the hint", () => {
		const out = spokenForm(
			askPart({ question: "What is the capital of France and what is the river that flows through it?" }),
			{ languageHint: "it" },
		);
		assert.ok(out);
		assert.equal(out.language, "en");
	});
});
