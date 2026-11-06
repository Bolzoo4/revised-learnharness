// tests/helpers/mcp-read-child.ts
// Child process for the hang tests: performs one read of a data directory and prints "ok ...".
// Run by a parent with a timeout, so a blocking read (a FIFO, /dev/zero) fails the test instead of hanging it.
import path from "node:path";
import { parseGoalEvent } from "../../src/core/ext/goals.ts";
import { createReadableGuard, readOnlyLedger } from "../../src/store/ext/readonly.ts";

const [root = "", what = ""] = process.argv.slice(2);
if (what === "ledger") {
	const events = readOnlyLedger(path.join(root, "ext"), "goals.jsonl", parseGoalEvent).readAll();
	console.log(`ok ${events.length}`);
} else if (what === "stamp") {
	createReadableGuard(root)();
	console.log("ok stamp");
} else {
	console.log("unknown");
	process.exit(2);
}
