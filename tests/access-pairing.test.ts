import assert from "node:assert/strict";
import test from "node:test";
import { createPairingStore, PAIRING_TTL_MS } from "../src/server/access/pairing.ts";

test("a fresh code redeems once and only once", () => {
	const store = createPairingStore();
	const { code } = store.create(1000);
	assert(store.redeem(code, 1001));
	assert(!store.redeem(code, 1002), "second use");
});

test("a code expires after five minutes", () => {
	const store = createPairingStore();
	const { code, expiresAt } = store.create(0);
	assert.equal(expiresAt, PAIRING_TTL_MS);
	assert.equal(PAIRING_TTL_MS, 5 * 60 * 1000);
	assert(!store.redeem(code, PAIRING_TTL_MS), "exactly at expiry is expired");
	const again = store.create(0);
	assert(store.redeem(again.code, PAIRING_TTL_MS - 1), "one ms before expiry is valid");
});

test("only one code is outstanding: a new one replaces the old", () => {
	const store = createPairingStore();
	const first = store.create(0);
	const second = store.create(10);
	assert(!store.redeem(first.code, 20));
	assert(store.redeem(second.code, 20));
});

test("wrong, empty, truncated and padded codes never redeem and do not burn the real one", () => {
	const store = createPairingStore();
	const { code } = store.create(0);
	for (const bad of ["", "x", code.slice(1), code + "x", code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase(), " " + code, `${code}\n`]) {
		assert(!store.redeem(bad, 1), JSON.stringify(bad));
	}
	assert(store.redeem(code, 2), "the genuine code still works after wrong guesses");
});

test("redeeming with nothing created is false", () => {
	assert(!createPairingStore().redeem("anything", 0));
});

test("codes carry 128 bits and are different every time", () => {
	const store = createPairingStore();
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const { code } = store.create(i);
		assert(/^[A-Za-z0-9_-]{22}$/.test(code), code);
		seen.add(code);
	}
	assert.equal(seen.size, 50);
});

test("the store keeps no plaintext code", () => {
	const store = createPairingStore();
	const { code } = store.create(0);
	assert(!JSON.stringify(store, (_key, value) => (typeof value === "function" ? undefined : value)).includes(code));
	assert(!Object.values(store).some((v) => typeof v === "string" && v.includes(code)));
});
