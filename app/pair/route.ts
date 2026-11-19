const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LearnHarness pairing</title>
<style>
:root{color-scheme:light dark}
body{font:16px -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(22rem,calc(100vw - 2rem));display:grid;gap:.75rem}
p{margin:0;color:GrayText}
</style></head><body>
<main><h1 style="font-size:1.1rem;margin:0">LearnHarness</h1><p role="status">Pairing…</p></main>
<script>
const message = document.querySelector("p");
const code = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
(async () => {
	if (!code) { message.textContent = "Open this page from the pairing QR code."; return; }
	try {
		const response = await fetch("/api/access/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
		if (response.ok) location.replace("/");
		else message.textContent = response.status === 429 ? "Too many attempts. Try again later." : "This pairing code is invalid or expired. Create a new one on the Mac.";
	} catch { message.textContent = "The server could not be reached."; }
})();
</script></body></html>`;

/** Plain HTML on purpose: it must render with no app layout, providers or gated assets. */
export function GET() {
	return new Response(HTML, {
		headers: {
			"content-type": "text/html; charset=utf-8", "cache-control": "no-store",
			"x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
		},
	});
}
