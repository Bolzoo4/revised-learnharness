# Use LearnHarness from your iPhone: start to finish

This is the short path. Details and security notes are in [service.md](service.md) and [ios-shell.md](ios-shell.md).

**What you get:** your Mac keeps running LearnHarness; your phone opens it over Tailscale (a private network between your own devices). Nothing is exposed to the public internet. The Mac must be on and awake.

**Today this works on macOS only** (the service is a launchd LaunchAgent). Windows and Android are not supported yet.

## 1. Tailscale (once)

1. Create a free account at [tailscale.com](https://tailscale.com) and install the Tailscale app on the Mac and on the iPhone. Sign in to the same account on both.
2. In the [admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS certificates** ([guide](https://tailscale.com/kb/1153/enabling-https)).
3. Check that both devices show as connected in the Tailscale app.

## 2. The service on the Mac (once)

```bash
scripts/ext-build-mac-local.sh --install   # builds the app into /Applications
scripts/service/install.sh                 # installs the always-on service
scripts/service/serve.sh on                # publishes it on your tailnet, prints the https:// address
```

In System Settings, allow the Mac to stay awake with the display off, or the phone will find it asleep.

## 3. Pair the phone

```bash
scripts/service/pair.sh                    # prints a link (and a QR code if `brew install qrencode`)
```

The code works once and expires in 5 minutes.

- **Easiest (no developer account):** open the link in Safari on the iPhone, tap Share, then **Add to Home Screen**.
- **Native app (microphone for voice mode is more reliable):** build and install `ios-shell/` as described in [ios-shell.md](ios-shell.md), then paste the link into the sign-in page. A free Apple account signs the app for 7 days; reinstall it before it expires.

## 4. Optional

- **Voice mode and dictation** need a Deepgram key with the Member role or higher (see [getting-started.md](getting-started.md)).
- **Web search without keys:** see [search.md](search.md).
- **Semantic search:** download the model once with `npx tsx scripts/embed-download.ts --yes --cache-dir "$HOME/Library/Application Support/LearnHarness/data/ext/models"` (about 315 MB).

## If something fails

- Phone cannot reach the address: Tailscale must be running on both devices, and `scripts/service/serve.sh status` must say it is published.
- Sign-in page asks for a code again: run `scripts/service/pair.sh` for a new one.
- Service log: `~/Library/Logs/learnharness-service.log`.
