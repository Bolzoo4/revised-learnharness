// tests/ext-study-panel.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-panel-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { extStores } = await import("../src/server/ext/stores.ts");
const { panelSources } = await import("../src/server/ext/panel-providers.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DOC = "c".repeat(64);
const AT = "2026-11-04T10:00:00.000Z";

describe("study sources in the node panel (REQ-study-10)", () => {
	it("lists the document title and page a node came from", () => {
		extStores.documentsLedger.append({ type: "registered", documentId: DOC, title: "Probability", pageCount: 200, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 12, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 12, at: AT });
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_a", documentId: DOC, page: 40, at: AT });
		assert.deepEqual(panelSources.studySources?.("n_a"), [
			{ documentId: DOC, title: "Probability", page: 12 },
			{ documentId: DOC, title: "Probability", page: 40 },
		]);
	});
	it("lists none for a node without links, and skips a link to a document that is not registered", () => {
		assert.deepEqual(panelSources.studySources?.("n_none"), []);
		extStores.studyLinksLedger.append({ type: "link", nodeId: "n_orphan", documentId: "e".repeat(64), page: 1, at: AT });
		assert.deepEqual(panelSources.studySources?.("n_orphan"), []);
	});
});
