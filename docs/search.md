# Web and literature search

The study agent's `web_search` tool uses one search engine at a time. Which engine answers depends on the keys you have saved and on an optional explicit choice in settings.

## Which engine is used

1. **An explicit choice wins.** If you pick an engine in Settings, the agent uses only that engine. If its API key is missing, or the service is down, search reports the reason. It does not silently switch to another engine.
2. **Keyed engines come next.** With no explicit choice, the first engine you have a key for is used, in this order: Tavily, Brave, Exa, Firecrawl, Ollama.
3. **Keyless engines are the fallback.** With no keys and no choice, the agent tries these in order: SearXNG, then OpenAlex, then Wikipedia. If one fails, the next one is tried. Search fails only when all of them fail, and the error names each reason.

Keyless engines need no account and no key:

| Engine | What it searches | Notes |
| --- | --- | --- |
| SearXNG | A metasearch of many web engines | Needs a local instance, described below. |
| OpenAlex | Scholarly works (papers, with abstracts when available) | Public API. Requests carry only the query. |
| Wikipedia | Encyclopaedia articles | Italian Wikipedia for Italian queries, English otherwise (short queries default to English). |

## Running SearXNG locally

SearXNG is a self-hosted metasearch engine. The app does not bundle it: you run it as a separate process, usually with Docker.

1. Create a settings folder, for example `~/searxng`, and add a `settings.yml`:

   ```yaml
   use_default_settings: true
   search:
     formats:
       - html
       - json
   server:
     secret_key: "replace-with-a-long-random-string"
     limiter: false
   ```

   - `search.formats` must include `json`. Without it, SearXNG answers the app with HTTP 403.
   - `limiter: false` disables SearXNG's bot limiter, which is meant for public instances. Keep it off only for a local instance that only you use.
   - Generate the secret with `openssl rand -hex 32`.

2. Start the container:

   ```sh
   docker run -d --name lh-searxng -p 8888:8080 -v <path-to-settings-folder>:/etc/searxng searxng/searxng
   ```

   Replace `<path-to-settings-folder>` with the folder from step 1. Check that it answers:

   ```sh
   curl "http://127.0.0.1:8888/search?q=test&format=json"
   ```

3. Point the app at the instance by setting the `SEARXNG_URL` environment variable before starting it. When it is unset, the app uses `http://127.0.0.1:8888`.

### Windows

The Docker route needs Docker Desktop, with the WSL 2 backend enabled. Run the commands above in PowerShell or in a WSL shell.

### Licence

SearXNG is licensed under AGPL-3.0. This project uses it only as a separate program that the app talks to over HTTP. Running it does not make the app subject to that licence, and the app does not include any SearXNG code.

## When search fails

- **Instance not running:** the agent gets "SearXNG is unreachable at …". Start the container, or let the automatic fallback use OpenAlex and Wikipedia.
- **HTTP 403:** JSON output is disabled. Add `json` to `search.formats` and restart the container.
- **Empty results with failed upstream engines:** SearXNG answers, but the search engines it queries failed or rate-limited it. The error names them. Try again later or with another query.
- **Malformed answer:** the app reports that the response was invalid, and it does not echo the response body.

The keyless engines receive only the search query. A keyed engine receives its own API key, which it needs to authenticate; nothing else about you is sent.
