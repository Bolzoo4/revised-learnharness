# The always-on service

LearnHarness can run its server as a launchd LaunchAgent. The desktop window and other clients (later, the iPhone) connect to it, so one process owns your data.

## Install

1. Build and install the app: `scripts/ext-build-mac-local.sh --install` (puts it in `/Applications`).
2. Install the service: `scripts/service/install.sh`.

The script creates the access token (`~/Library/Application Support/LearnHarness/access-token`, mode `0600`), writes `~/Library/LaunchAgents/org.revisedlearnharness.app.plist` and starts the service on `127.0.0.1:47890`. Set `LH_PORT` before installing to change the port. The service runs the installed app's own Electron binary as Node, with the bundled server, the same data folder and the same `auth.json` as the app.

Logs: `~/Library/Logs/learnharness-service.log`.

## How the app uses it

On launch the app reads the port from the plist, calls `/healthz`, restarts the service if its version differs from the app's, signs in once with the token and keeps only the session cookie. If the service is not installed, or does not become ready in time, the app shows an error window with the log path. `npm run desktop:dev` is unchanged: it talks to a local `next dev` and needs no service.

Updates: when an update is downloaded, the app stops the service (`launchctl bootout`) before the bundle is replaced, and the next app launch starts it again. `scripts/ext-build-mac-local.sh --install` does the same around its copy.

The service outlives the app: quitting the window does not stop it.

## Access

A gate in `proxy.ts` (`src/server/access/`) checks every request. Every page and API request needs a session cookie, except `/healthz`, `/signin` and `/api/access/signin`. The host and Tailscale checks below still apply to those three paths.

- Sign in at `/signin` with the token. The token is accepted only by `/api/access/signin`, compared in constant time. The cookie is signed, `HttpOnly`, `SameSite=Strict`, and lasts 90 days.
- `Secure` is set on the cookie unless the request's `Host` is loopback (`127.0.0.1:<port>` or `localhost:<port>`). The flag is derived from the `Host` header, not from the connection; behind Tailscale Serve this still has to be verified.
- Requests whose `Host` is not listed in `LH_ACCESS_ALLOWED_HOSTS` get 421.
- If a request carries `Tailscale-User-Login`, it must equal `LH_ACCESS_TAILSCALE_LOGIN`, otherwise it gets 403. If the header is absent, only the token applies.
- State-changing requests (anything but GET, HEAD, OPTIONS) need a same-origin `Origin`.
- Five wrong tokens within a minute lock sign-in for five minutes (one global limit, because behind Serve every request comes from loopback).

Rotate the token (this signs out every device and restarts the service): `scripts/service/rotate-token.sh`.

Development: when `NODE_ENV` is not `production` and `LH_ACCESS_TOKEN_FILE` is not set, the gate runs in open mode. There is no token and no cookie check. Production always enforces the gate, and the server refuses to start unless the token file is readable and at least 32 characters after trimming.

## Remove

`scripts/service/uninstall.sh` removes the LaunchAgent and keeps the token and your data.

## Notes

- Only one server may use a data folder. A second server on it refuses to start and logs the pid of the first.
- A server started in production without a valid token file refuses to start.
- ChatGPT sign-in completes in a browser on the Mac that runs the service (its callback is on `127.0.0.1`).
- The Mac must be awake for the service to answer.
- Not yet covered (sub-project 2): Tailscale Serve publication, QR pairing, the Funnel guard, and Mac sleep guidance.
