// tests/ios-microphone-usage.test.ts
// The iOS app asks for the microphone only if its Info.plist says why (NSMicrophoneUsageDescription).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

describe("iOS shell microphone", () => {
	it("Info.plist carries the microphone usage description in plain English", () => {
		const plist = fs.readFileSync(path.join(import.meta.dirname, "../ios-shell/ios/App/App/Info.plist"), "utf-8");
		assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>LearnHarness listens to your voice to dictate and to answer questions in voice mode\.<\/string>/);
	});
});
