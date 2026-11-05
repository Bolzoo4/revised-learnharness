import assert from "node:assert/strict";
import { it } from "node:test";
import { chainSourceDirectory, emptySourceOrganization } from "../src/core/source-organization.ts";

it("chain source directory hides practice, review and office_hours sessions", () => {
	const kinds = ["practice", "review", "office_hours", "teach"] as const;
	const sources = kinds.map((k) => ({ id: k, kind: "chat" as const, chatKind: k, label: k, createdAt: "now" }));
	const view = chainSourceDirectory({ organization: emptySourceOrganization(), sources });
	assert.deepEqual(view.sources.map((s) => s.id), ["teach"]);
});
