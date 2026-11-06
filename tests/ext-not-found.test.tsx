import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "../app/not-found.tsx";

test("the 404 page offers a way back home", () => {
	const html = renderToStaticMarkup(NotFound());
	assert.match(html, /Page not found/);
	assert.match(html, /href="\/"/);
});
