const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LearnHarness sign-in</title>
<style>
:root{color-scheme:light dark}
body{font:16px -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
form{width:min(22rem,calc(100vw - 2rem));display:grid;gap:.75rem}
input,button{font:inherit;padding:.65rem .75rem;border-radius:.5rem;border:1px solid GrayText;background:Field;color:FieldText}
button{cursor:pointer}
p{min-height:1.25rem;margin:0;color:GrayText}
</style></head><body>
<form autocomplete="off">
<h1 style="font-size:1.1rem;margin:0">LearnHarness</h1>
<input name="token" type="password" placeholder="Access token" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
<p role="status"></p>
</form>
<script>
const form = document.querySelector("form"), message = document.querySelector("p");
form.addEventListener("submit", async (event) => {
	event.preventDefault(); message.textContent = "";
	try {
		const response = await fetch("/api/access/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: form.token.value }) });
		if (response.ok) location.replace("/");
		else message.textContent = response.status === 429 ? "Too many attempts. Try again later." : "That token was not accepted.";
	} catch { message.textContent = "The server could not be reached."; }
});
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
