// scripts/ext-check-speech.cjs
// Environment check for the lecture player (child spec 4, REQ-lec-09): does the
// Electron renderer have a working speechSynthesis with word-boundary events?
// Run: npx electron scripts/ext-check-speech.cjs
// Exit 0 = usable (voices present, speech ends, boundary events fire).
// It speaks one short sentence aloud.
const { app, BrowserWindow } = require("electron");

const probe = `(async () => {
	if (!("speechSynthesis" in window)) return { supported: false };
	const voices = await new Promise((resolve) => {
		const have = speechSynthesis.getVoices();
		if (have.length > 0) return resolve(have);
		const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 3000);
		speechSynthesis.onvoiceschanged = () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); };
	});
	const events = { start: false, boundary: 0, end: false, error: null };
	await new Promise((resolve) => {
		const u = new SpeechSynthesisUtterance("Hello. This is a test of speech synthesis in the lecture player.");
		u.onstart = () => { events.start = true; };
		u.onboundary = () => { events.boundary += 1; };
		u.onend = () => { events.end = true; resolve(); };
		u.onerror = (e) => { events.error = e.error; resolve(); };
		speechSynthesis.speak(u);
		setTimeout(resolve, 15000);
	});
	return { supported: true, voices: voices.length, sample: voices.slice(0, 3).map((v) => v.name + " (" + v.lang + ")"), events };
})()`;

app.whenReady().then(async () => {
	const win = new BrowserWindow({ show: false });
	await win.loadURL("data:text/html,<html><body>probe</body></html>");
	let result;
	try {
		result = await win.webContents.executeJavaScript(probe);
	} catch (e) {
		result = { supported: false, error: String(e) };
	}
	const usable = result.supported === true && result.voices > 0 && result.events.end === true && result.events.boundary > 0;
	console.log(JSON.stringify({ electron: process.versions.electron, usable, ...result }, null, 2));
	app.exit(usable ? 0 : 1);
});
