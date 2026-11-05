import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { makeLecture, NODE_A } from "./helpers/lecture-fixture.ts";

// The seam, BEFORE any config-loading import (same discipline as chat-kind.test.ts).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-panel-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { extStores } = await import("../src/server/ext/stores.ts");
const { panelSources } = await import("../src/server/ext/panel-providers.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("lecture back-links in the node panel (REQ-lec-12)", () => {
	it("lists the lectures that cite a node, in the panel's shape", () => {
		extStores.lecturesStore.save(makeLecture());
		assert.deepEqual(panelSources.lecturesCiting?.(NODE_A), [{ lectureId: "lec_b0123abcd_c02_l01", title: "Sigma algebras" }]);
	});
	it("lists none for a node no lecture cites", () => {
		assert.deepEqual(panelSources.lecturesCiting?.("n_none0000"), []);
	});
});
