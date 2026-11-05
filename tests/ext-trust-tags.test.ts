// tests/ext-trust-tags.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newGraphContextMessage } from "../src/core/native-messages.ts";
import { trustTag } from "../src/core/ext/trust.ts";

describe("trust tags in the graph-context message (REQ-src-15)", () => {
	it("a tagged statement reaches the model-facing content, one tag per proposition", () => {
		const msg = newGraphContextMessage(
			[
				{ id: "n1", name: "Angle sum", statement: `Angles sum to 180. ${trustTag("sourced")}` },
				{ id: "n2", name: "Parallel", statement: `Parallels never meet. ${trustTag("unverified")}` },
			],
			[],
		);
		const content = String(msg.content);
		assert.match(content, /\[n1\] Angle sum: Angles sum to 180\. \[trust: sourced/);
		assert.match(content, /\[n2\] Parallel: Parallels never meet\. \[trust: unverified/);
	});
});
