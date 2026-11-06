// tests/ext-mcp-lecture-index.test.ts
/**
 * The citing-lecture index behind get_node (REQ-mcp-04, REQ-mcp-08, adversarial).
 * The index is per process and in memory: each call re-stats the lecture files,
 * parses only new or changed ones, forgets deleted ones, and never fails the
 * node read. Every test here fails if the behaviour it names is removed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { citingLectures } from "../src/core/ext/lecture/lecture-graph.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { runTool } from "../src/core/ext/mcp/tools.ts";
import { CITING_OMITTED_REASON } from "../src/core/ext/mcp/node.ts";
import { createLectureReader, type LectureFs } from "../src/store/ext/readonly.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { cleanupAllFixtures, makeFixture, N, seedGraph, type Fixture } from "./helpers/mcp-fixture.ts";

afterEach(cleanupAllFixtures);

const ALL_NODES = [N.a, N.b, N.c, N.d, N.lone, "n_missing00"];

/** A lecture whose only node references are `nodeIds` (blocks), so the citing tests are exact. */
function citing(id: string, nodeIds: string[], extra: Record<string, unknown> = {}) {
	return makeLecture({
		id,
		title: `Lecture ${id.slice(-6)}`,
		slides: [{ id: "s1", heading: "Only slide", elements: [] }],
		blocks: [{ id: "b1", role: "narrate", slideId: "s1", text: "Some narration.", nodeIds, cues: [] }],
		...extra,
	});
}

const lecturePath = (f: Fixture, id: string): string => path.join(f.extDir, "lectures", id, "lecture.json");

function putLecture(f: Fixture, lecture: ReturnType<typeof makeLecture>, raw?: string): void {
	fs.mkdirSync(path.dirname(lecturePath(f, lecture.id)), { recursive: true });
	fs.writeFileSync(lecturePath(f, lecture.id), raw ?? JSON.stringify(lecture));
}

/**
 * A lecture file system that counts every read and refuses (throws) to read a
 * non-regular file, so a wrong implementation fails fast instead of hanging on
 * /dev/zero.
 */
function countingFs(): { fs: LectureFs; stats: { reads: string[]; bytes: number } } {
	const stats = { reads: [] as string[], bytes: 0 };
	const io: LectureFs = {
		statSync: (file) => fs.statSync(file),
		readFileSync: (file, encoding) => {
			const st = fs.statSync(file);
			if (!st.isFile()) throw new Error(`refused to read a non-file: ${path.basename(file)}`);
			stats.reads.push(file);
			stats.bytes += st.size;
			return fs.readFileSync(file, encoding);
		},
		readdirSync: (dir) => fs.readdirSync(dir),
	};
	return { fs: io, stats };
}

/** The fixture's deps, with the lecture reader replaced by one that uses `io`. */
function depsWith(f: Fixture, io: LectureFs, totalBytesMax?: number) {
	return { ...f.deps, lectures: createLectureReader(f.extDir, { io, totalBytesMax }) };
}

function getNode(deps: ReturnType<typeof depsWith>, id: string) {
	return runTool("get_node", deps, { id }, { knowledgeOnly: false }) as {
		id: string;
		name: string;
		citingLectures: { items: { lectureId: string; title: string }[]; count: number; truncated: boolean } | null;
		citingLecturesOmitted: boolean;
		citingLecturesOmittedReason: string | null;
	};
}

const citedIds = (r: ReturnType<typeof getNode>): string[] => (r.citingLectures?.items ?? []).map((i) => i.lectureId);

describe("get_node reads the lecture index, not the whole lecture set (REQ-mcp-04)", () => {
	it("two get_node calls parse each lecture file exactly once", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a]));
		putLecture(f, citing("lec_b0123abcd_c02_l02", [N.a, N.b]));
		putLecture(f, citing("lec_b0123abcd_c02_l03", [N.c]));
		const io = countingFs();
		const deps = depsWith(f, io.fs);
		assert.deepEqual(citedIds(getNode(deps, N.a)), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c02_l02"]);
		assert.deepEqual(citedIds(getNode(deps, N.a)), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c02_l02"]);
		assert.equal(io.stats.reads.length, 3, "three files, read once each, across two calls");
		assert.equal(new Set(io.stats.reads).size, 3, "no file was read twice");
	});

	it("a modified lecture (mtime and size change) is parsed again and the answer updates", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a]));
		const io = countingFs();
		const deps = depsWith(f, io.fs);
		assert.deepEqual(citedIds(getNode(deps, N.a)), ["lec_b0123abcd_c02_l01"]);
		// Rewrite the file so it cites B instead, and move its mtime so the stamp must change.
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.b], { title: "Changed title and a longer body to change the size" }));
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(lecturePath(f, "lec_b0123abcd_c02_l01"), later, later);
		assert.deepEqual(citedIds(getNode(deps, N.a)), [], "A is no longer cited");
		assert.deepEqual(citedIds(getNode(deps, N.b)), ["lec_b0123abcd_c02_l01"], "B is cited now");
		assert.equal(io.stats.reads.length, 2, "the changed file was parsed again, nothing else");
	});

	it("a lecture whose mtime alone changes is parsed again (the stamp covers mtime, not only size)", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a]));
		const io = countingFs();
		const deps = depsWith(f, io.fs);
		getNode(deps, N.a);
		const later = new Date(Date.now() + 120_000);
		fs.utimesSync(lecturePath(f, "lec_b0123abcd_c02_l01"), later, later);
		getNode(deps, N.a);
		assert.equal(io.stats.reads.length, 2, "same size, new mtime: read again");
	});

	it("a deleted lecture disappears from the answer", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a]));
		putLecture(f, citing("lec_b0123abcd_c02_l02", [N.a]));
		const deps = depsWith(f, countingFs().fs);
		assert.equal(getNode(deps, N.a).citingLectures?.count, 2);
		fs.rmSync(path.dirname(lecturePath(f, "lec_b0123abcd_c02_l01")), { recursive: true });
		assert.deepEqual(citedIds(getNode(deps, N.a)), ["lec_b0123abcd_c02_l02"]);
	});

	it("a new lecture appears in the answer on the next call, and only it is parsed", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a]));
		const io = countingFs();
		const deps = depsWith(f, io.fs);
		getNode(deps, N.a);
		putLecture(f, citing("lec_b0123abcd_c02_l02", [N.a]));
		assert.deepEqual(citedIds(getNode(deps, N.a)), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c02_l02"]);
		assert.equal(io.stats.reads.length, 2, "one read for the first lecture, one for the new one");
	});
});

describe("the read budget never fails get_node (REQ-mcp-08, adversarial)", () => {
	function manyLectures(f: Fixture, count: number, summaryChars: number): number {
		let bytes = 0;
		for (let i = 0; i < count; i++) {
			const id = `lec_b${(i + 1).toString(16).padStart(8, "0")}_c02_l01`;
			const lecture = citing(id, [N.a], { summary: "s".repeat(summaryChars) });
			const text = JSON.stringify(lecture);
			putLecture(f, lecture, text);
			bytes += Buffer.byteLength(text);
		}
		return bytes;
	}

	it("over the budget get_node returns the node without citing lectures, flagged, and no error", () => {
		const f = makeFixture();
		seedGraph(f);
		const bytes = manyLectures(f, 40, 2000);
		const deps = depsWith(f, countingFs().fs, Math.floor(bytes / 2));
		const r = getNode(deps, N.a);
		assert.equal(r.id, N.a);
		assert.equal(r.name, "Axiom A");
		assert.equal(r.citingLectures, null);
		assert.equal(r.citingLecturesOmitted, true);
		assert.equal(r.citingLecturesOmittedReason, CITING_OMITTED_REASON);
	});

	it("repeated calls resume the index until it is complete, parsing each lecture once in total", () => {
		const f = makeFixture();
		seedGraph(f);
		const bytes = manyLectures(f, 40, 2000);
		const io = countingFs();
		const deps = depsWith(f, io.fs, Math.floor(bytes / 2));
		let calls = 0;
		let r = getNode(deps, N.a);
		calls++;
		while (r.citingLecturesOmitted && calls < 10) {
			r = getNode(deps, N.a);
			calls++;
		}
		assert.equal(r.citingLecturesOmitted, false, "complete within a few calls");
		assert.equal(r.citingLectures?.count, LIMITS.citingLecturesMax, "the page is capped, the index holds all 40");
		assert.equal(r.citingLectures?.truncated, true);
		assert.equal(io.stats.reads.length, 40, "every lecture parsed once in total, none twice");
	});

	it("one call never parses more bytes than the budget (the first file of a call is always admitted)", () => {
		const f = makeFixture();
		seedGraph(f);
		const bytes = manyLectures(f, 40, 2000);
		const budget = Math.floor(bytes / 2);
		const io = countingFs();
		getNode(depsWith(f, io.fs, budget), N.a);
		assert.ok(io.stats.bytes <= budget, `read ${io.stats.bytes} bytes in one call, budget ${budget}`);
		assert.ok(io.stats.reads.length > 0, "some progress was made");
	});

	it("a budget smaller than one file still completes: one file per call, no call is wasted", () => {
		const f = makeFixture();
		seedGraph(f);
		manyLectures(f, 5, 100);
		const deps = depsWith(f, countingFs().fs, 1);
		let calls = 0;
		let r = getNode(deps, N.a);
		calls++;
		while (r.citingLecturesOmitted && calls < 20) {
			r = getNode(deps, N.a);
			calls++;
		}
		assert.equal(r.citingLecturesOmitted, false);
		assert.equal(r.citingLectures?.count, 5);
		assert.equal(calls, 5, "one lecture per call");
	});
});

describe("hostile lecture files never break get_node for the others (REQ-mcp-03, adversarial)", () => {
	it("invalid JSON, an oversize file, a symlink to /dev/zero and a wrong id are skipped; the good lectures still answer", () => {
		const f = makeFixture();
		seedGraph(f);
		const good = "lec_b0123abcd_c02_l01";
		putLecture(f, citing(good, [N.a]));
		putLecture(f, citing("lec_b0123abcd_c02_l02", [N.a]), "{ this is not json");
		const huge = citing("lec_b0123abcd_c02_l03", [N.a], { summary: "h".repeat(LIMITS.lectureFileMaxBytes + 10) });
		putLecture(f, huge);
		fs.mkdirSync(path.dirname(lecturePath(f, "lec_b0123abcd_c02_l04")), { recursive: true });
		fs.symlinkSync("/dev/zero", lecturePath(f, "lec_b0123abcd_c02_l04"));
		fs.mkdirSync(path.dirname(lecturePath(f, "lec_b0123abcd_c02_l05")), { recursive: true });
		fs.writeFileSync(lecturePath(f, "lec_b0123abcd_c02_l05"), JSON.stringify(citing("lec_b0123abcd_c02_l01", [N.a]))); // file under l05 that says l01
		putLecture(f, citing("lec_b0123abcd_c02_l06", [N.b]));

		const io = countingFs();
		const deps = depsWith(f, io.fs);
		const r = getNode(deps, N.a);
		assert.equal(r.citingLecturesOmitted, false);
		assert.deepEqual(citedIds(r), [good], "only the valid lecture under its own id cites A");
		assert.ok(!io.stats.reads.some((p) => p.includes("l03") || p.includes("l04")), "the oversize file and the device symlink were never read");
		assert.deepEqual(citedIds(getNode(deps, N.b)), ["lec_b0123abcd_c02_l06"], "the other nodes still answer");
	});
});

describe("results match the full-scan implementation (golden comparison)", () => {
	it("on a mixed fixture the index gives exactly what citingLectures gives over list()", () => {
		const f = makeFixture();
		seedGraph(f);
		putLecture(f, citing("lec_b0123abcd_c02_l01", [N.a, N.b], { bookTitle: "Book Z" }));
		putLecture(f, citing("lec_b0123abcd_c02_l02", [N.a], { bookTitle: "Book A", chapter: { index: 3, title: "Second chapter", pageStart: 1, pageEnd: 2 } }));
		putLecture(f, citing("lec_b0123abcd_c02_l03", [N.c, N.d]));
		fs.mkdirSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l04"), { recursive: true });
		fs.writeFileSync(lecturePath(f, "lec_b0123abcd_c02_l04"), JSON.stringify(citing("lec_b0123abcd_c02_l09", [N.a]))); // wrong dir: not a lecture
		fs.mkdirSync(path.dirname(lecturePath(f, "lec_b0123abcd_c02_l07")), { recursive: true });
		fs.writeFileSync(lecturePath(f, "lec_b0123abcd_c02_l07"), "not json");
		const reader = createLectureReader(f.extDir);
		for (const id of ALL_NODES) {
			const golden = citingLectures(id, reader.list()).map((l) => ({ lectureId: l.id, title: l.title }));
			const mine = (reader.citing(id) ?? []).map((l) => ({ lectureId: l.id, title: l.title }));
			assert.deepEqual(mine, golden, `citing(${id})`);
		}
	});
});
