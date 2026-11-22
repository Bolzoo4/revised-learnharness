// tests/answer-resolver.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOpen, resolveOption } from "../src/core/answer-resolver.ts";

const planets = [{ label: "Mercurio" }, { label: "Venere" }, { label: "Marte" }, { label: "Giove" }];
const english = [{ label: "Mercury" }, { label: "Venus" }, { label: "Mars" }];

describe("resolveOption: letter forms", () => {
	it("resolves a bare letter", () => {
		assert.deepEqual(resolveOption("B", planets), { kind: "option", index: 1, value: "Venere" });
	});

	it("resolves a letter after Italian prefixes", () => {
		for (const t of ["la B", "opzione b", "risposta b", "lettera b", "la b."]) {
			assert.deepEqual(resolveOption(t, planets), { kind: "option", index: 1, value: "Venere" }, t);
		}
	});

	it("resolves a letter after English prefixes", () => {
		for (const t of ["option b", "letter b", "the b one", "B!"]) {
			assert.deepEqual(resolveOption(t, english), { kind: "option", index: 1, value: "Venus" }, t);
		}
	});

	it("returns the option's value when it has one", () => {
		const opts = [{ label: "Mercury", value: "key-a" }, { label: "Venus", value: "key-b" }];
		assert.deepEqual(resolveOption("b", opts), { kind: "option", index: 1, value: "key-b" });
	});

	it("resolves letters case-insensitively", () => {
		assert.deepEqual(resolveOption("LA C", planets), { kind: "option", index: 2, value: "Marte" });
	});

	it("returns none for a letter beyond the option count", () => {
		assert.deepEqual(resolveOption("la F", planets), { kind: "none" });
		assert.deepEqual(resolveOption("f", english), { kind: "none" });
	});
});

describe("resolveOption: the single-letter 'a' guard", () => {
	it("counts a bare 'a' as letter A when it is the whole transcript", () => {
		assert.deepEqual(resolveOption("a", planets), { kind: "option", index: 0, value: "Mercurio" });
	});

	it("counts 'a' after la / opzione / risposta / letter / option", () => {
		assert.deepEqual(resolveOption("la a", planets), { kind: "option", index: 0, value: "Mercurio" });
		assert.deepEqual(resolveOption("opzione a", planets), { kind: "option", index: 0, value: "Mercurio" });
		assert.deepEqual(resolveOption("risposta a", planets), { kind: "option", index: 0, value: "Mercurio" });
		assert.deepEqual(resolveOption("letter a", english), { kind: "option", index: 0, value: "Mercury" });
		assert.deepEqual(resolveOption("option a", english), { kind: "option", index: 0, value: "Mercury" });
	});

	it("does not count the preposition 'a' inside a sentence", () => {
		assert.deepEqual(resolveOption("penso a Venere", planets), { kind: "option", index: 1, value: "Venere" });
		assert.deepEqual(resolveOption("a Giove", planets), { kind: "option", index: 3, value: "Giove" });
	});

	it("does not treat the Italian article 'a' or 'e' as a letter when they stand next to other words", () => {
		assert.deepEqual(resolveOption("a volte", planets), { kind: "none" });
		assert.deepEqual(resolveOption("e poi", planets), { kind: "none" });
	});
});

describe("resolveOption: ordinals, number words and digits", () => {
	it("resolves Italian ordinals", () => {
		assert.deepEqual(resolveOption("la seconda", planets), { kind: "option", index: 1, value: "Venere" });
		assert.deepEqual(resolveOption("la prima", planets), { kind: "option", index: 0, value: "Mercurio" });
		assert.deepEqual(resolveOption("la terza", planets), { kind: "option", index: 2, value: "Marte" });
	});

	it("resolves English ordinals", () => {
		assert.deepEqual(resolveOption("the second", english), { kind: "option", index: 1, value: "Venus" });
		assert.deepEqual(resolveOption("third", english), { kind: "option", index: 2, value: "Mars" });
	});

	it("resolves number words with their prefix", () => {
		assert.deepEqual(resolveOption("number two", english), { kind: "option", index: 1, value: "Venus" });
		assert.deepEqual(resolveOption("numero due", planets), { kind: "option", index: 1, value: "Venere" });
	});

	it("resolves digits", () => {
		assert.deepEqual(resolveOption("2", planets), { kind: "option", index: 1, value: "Venere" });
		assert.deepEqual(resolveOption("opzione 4", planets), { kind: "option", index: 3, value: "Giove" });
	});

	it("returns none for an ordinal beyond the option count", () => {
		assert.deepEqual(resolveOption("la quinta", planets), { kind: "none" });
		assert.deepEqual(resolveOption("7", planets), { kind: "none" });
	});
});

describe("resolveOption: label matching", () => {
	it("matches an exact label", () => {
		assert.deepEqual(resolveOption("Giove", planets), { kind: "option", index: 3, value: "Giove" });
	});

	it("ignores accents and punctuation", () => {
		const opts = [{ label: "Più vicino" }, { label: "Lontano" }];
		assert.deepEqual(resolveOption("piu vicino!", opts), { kind: "option", index: 0, value: "Più vicino" });
	});

	it("ignores stopwords", () => {
		const opts = [{ label: "La fotosintesi clorofilliana" }, { label: "La respirazione cellulare" }];
		assert.deepEqual(resolveOption("fotosintesi clorofilliana", opts), {
			kind: "option",
			index: 0,
			value: "La fotosintesi clorofilliana",
		});
	});

	it("matches a label that the transcript states in full among other words", () => {
		const opts = [{ label: "Respirazione cellulare" }, { label: "Fotosintesi" }];
		assert.deepEqual(resolveOption("la respirazione cellulare", opts), {
			kind: "option",
			index: 0,
			value: "Respirazione cellulare",
		});
	});

	it("returns none when nothing matches", () => {
		assert.deepEqual(resolveOption("non so", planets), { kind: "none" });
		assert.deepEqual(resolveOption("pizza", planets), { kind: "none" });
	});

	it("returns none when the overlap is below the threshold", () => {
		const opts = [{ label: "Fotosintesi clorofilliana nei cloroplasti" }, { label: "Altro" }];
		assert.deepEqual(resolveOption("fotosintesi", opts), { kind: "none" });
	});

	it("is ambiguous when two labels tie", () => {
		const opts = [{ label: "Roma capitale" }, { label: "Roma capitale" }];
		assert.deepEqual(resolveOption("Roma capitale", opts), { kind: "ambiguous" });
	});

	it("is ambiguous when the runner-up is close (less than 0.2 behind)", () => {
		const opts = [{ label: "fiume Po nord" }, { label: "fiume Po sud" }];
		// "fiume Po" scores 2/3 against both labels: a tie, so ambiguous.
		assert.deepEqual(resolveOption("fiume Po", opts), { kind: "ambiguous" });
	});

	it("picks the best label when it clearly beats the runner-up", () => {
		const opts = [{ label: "Respirazione cellulare" }, { label: "Fotosintesi clorofilliana" }];
		assert.deepEqual(resolveOption("fotosintesi clorofilliana", opts), {
			kind: "option",
			index: 1,
			value: "Fotosintesi clorofilliana",
		});
	});
});

describe("resolveOption: corrections and conflicting letters", () => {
	it("is ambiguous when two different letters are named with no correction word", () => {
		assert.deepEqual(resolveOption("b e c", planets), { kind: "ambiguous" });
		assert.deepEqual(resolveOption("la b o la c", planets), { kind: "ambiguous" });
	});

	it("takes the last named letter when a correction word is present", () => {
		assert.deepEqual(resolveOption("b no aspetta la c", planets), { kind: "option", index: 2, value: "Marte" });
		assert.deepEqual(resolveOption("b anzi c", planets), { kind: "option", index: 2, value: "Marte" });
		assert.deepEqual(resolveOption("b wait actually c", english), { kind: "option", index: 2, value: "Mars" });
		assert.deepEqual(resolveOption("a scratch that c", english), { kind: "option", index: 2, value: "Mars" });
	});

	it("treats the same letter named twice as one answer", () => {
		assert.deepEqual(resolveOption("b, sì, la b", planets), { kind: "option", index: 1, value: "Venere" });
	});
});

describe("resolveOption: language hint", () => {
	it("accepts the language argument without changing letter resolution", () => {
		assert.deepEqual(resolveOption("la b", planets, "it"), { kind: "option", index: 1, value: "Venere" });
		assert.deepEqual(resolveOption("option b", english, "en"), { kind: "option", index: 1, value: "Venus" });
	});
});

describe("resolveOpen", () => {
	it("returns the trimmed transcript", () => {
		assert.equal(resolveOpen("  Because the membrane is selective.  "), "Because the membrane is selective.");
	});

	it("returns null for an empty or blank transcript", () => {
		assert.equal(resolveOpen(""), null);
		assert.equal(resolveOpen("   \n "), null);
	});
});
