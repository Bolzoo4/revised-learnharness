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

A gate in `proxy.ts` (`src/server/access/`) checks every request except the framework's static files (`/_next/static/`, `/_next/image`, `/favicon.ico`). Every other page and API request needs a session cookie, except `/healthz`, `/signin` and `/api/access/signin`. The host and Tailscale checks below still apply to those three paths.

- Sign in at `/signin` with the token. The token is accepted only by `/api/access/signin`, compared in constant time. The cookie is signed, `HttpOnly`, `SameSite=Strict`, and lasts 90 days on loopback and 14 days on any other host (see Remote access).
- `Secure` is set on the cookie unless the request's `Host` is loopback (`127.0.0.1:<port>` or `localhost:<port>`). The flag is derived from the `Host` header, not from the connection; behind Tailscale Serve this still has to be verified.
- Requests whose `Host` is not listed in `LH_ACCESS_ALLOWED_HOSTS` get 421.
- If a request carries `Tailscale-User-Login`, it must equal `LH_ACCESS_TAILSCALE_LOGIN`, otherwise it gets 403. If the header is absent, only the token applies.
- State-changing requests (anything but GET, HEAD, OPTIONS) need a same-origin `Origin`.
- Five wrong tokens within a minute lock sign-in for five minutes (one global limit, because behind Serve every request comes from loopback).

Rotate the token (this signs out every device and restarts the service): `scripts/service/rotate-token.sh`.

Development: when `NODE_ENV` is not `production` and `LH_ACCESS_TOKEN_FILE` is not set, the gate runs in open mode. There is no token and no cookie check. Production always enforces the gate, and the server refuses to start unless the token file is readable and at least 32 characters after trimming.

## Remote access (iPhone)

The service can be reached from other devices on your tailnet over HTTPS. A phone is paired with a one-time code, not with the token.

1. **One-time Tailscale setup.** In the Tailscale admin console, enable MagicDNS and HTTPS certificates ([enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). The Tailscale app must be running on the Mac and on the phone.
2. **Publish.** `scripts/service/serve.sh on` maps tailnet port 8444 to the service over TLS-terminated TCP and prints `https://<mac>.<tailnet>.ts.net:8444`. Set `LH_SERVE_PORT` to use another port. The service must already be installed. The script refuses 443, 8443, 10000 and ports outside 1024-65535, and refuses a port that Serve maps to something else. It never resets Serve or changes other mappings. It then reruns `install.sh`, which restarts the service with the new host allowed. `serve.sh status` shows whether the port is published; `serve.sh off` removes the mapping. The published host:port is saved in `~/Library/Application Support/LearnHarness/tailnet-host`.
3. **Pair a phone.** `scripts/service/pair.sh` prints a link, `https://<mac>.<tailnet>.ts.net:8444/pair#<code>`, and a QR code when `qrencode` is installed (`brew install qrencode`). The code is valid for 5 minutes and works once. Opening the link gives the phone a 14-day session. The link never contains the access token.
4. **Security notes.**
   - This mode is TCP forwarding, not Tailscale's HTTP proxy, so Tailscale adds no identity header. Access rests on tailnet reachability plus the session cookie.
   - Funnel cannot publish this port (it publishes only 443, 8443 and 10000), so the service is not exposed to the public internet this way.
   - Browsers share cookies across ports of the same host, so the session cookie is also sent to other apps on the same `*.ts.net` name. This is why remote sessions last 14 days. The cookie is `HttpOnly`, `Secure`, `SameSite=Strict`.
   - For any non-loopback host the service treats the scheme as `https`.
5. **Mac sleep.** The service answers only while the Mac is awake. For always-on use, turn on "Prevent automatic sleeping when the display is off" in System Settings (Battery or Energy, depending on the macOS version), or an equivalent setting.

## Remove

`scripts/service/uninstall.sh` removes the LaunchAgent and keeps the token and your data.

## Notes

- Only one server may use a data folder. A second server on it refuses to start and logs the pid of the first. This includes `next dev` pointed at the same `LH_DATA_DIR` as the service: use a different data folder for development.
- A server started in production without a valid token file refuses to start.
- ChatGPT sign-in completes in a browser on the Mac that runs the service (its callback is on `127.0.0.1`).
- The Mac must be awake for the service to answer.
