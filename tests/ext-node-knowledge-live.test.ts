// tests/ext-node-knowledge-live.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as server from "../src/server/ext/index.ts";
import * as core from "../src/core/ext/index.ts";

describe("node-knowledge wiring", () => {
	it("the server barrel exports the entry points the routes and the lecture pipeline use", () => {
		for (const name of ["nodePanel", "ensureNodeExplanation", "generateNodeExplanations", "saveNodeExplanation", "decideNodeProposal", "runNodeAction"] as const) {
			assert.equal(typeof server[name], "function", name);
		}
		assert.equal(typeof server.NodeKnowledgeError, "function");
	});

	it("the core barrel is browser-safe: it exposes the client helpers and no graph reader", () => {
		assert.equal(typeof core.linkifyNodeLinks, "function");
		assert.equal(typeof core.neighbourhood, "function");
		assert.equal(typeof core.historyOpen, "function");
		assert.equal(core.NODE_ACTIONS.length, 7);
		assert.equal("buildNodePanel" in core, false);
	});
});
