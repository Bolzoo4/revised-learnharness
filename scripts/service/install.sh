#!/usr/bin/env bash
# Install the LearnHarness always-on service (a launchd LaunchAgent).
#   scripts/service/install.sh
# Optional environment:
#   LH_APP                app bundle (default /Applications/LearnHarness.app)
#   LH_PORT               loopback port (default 47890)
#   LH_TAILNET_HOST       tailnet host:port to accept in the Host header, or the host:port saved by serve.sh (sub-project 2)
#   LH_TAILSCALE_LOGIN    the one Tailscale login allowed through Serve (sub-project 2)
#   LH_SERVICE_DRY_RUN=1  write files, do not call launchctl (used by tests)
set -euo pipefail

LABEL="$("$(dirname "$0")/label.sh")"
APP="${LH_APP:-/Applications/LearnHarness.app}"
PORT="${LH_PORT:-47890}"
SUPPORT="$HOME/Library/Application Support/LearnHarness"
TOKEN_FILE="$SUPPORT/access-token"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/learnharness-service.log"
HOSTS="127.0.0.1:$PORT,localhost:$PORT"
# serve.sh stores the tailnet host:port it published; an explicit LH_TAILNET_HOST wins.
if [ -z "${LH_TAILNET_HOST:-}" ] && [ -s "$SUPPORT/tailnet-host" ]; then LH_TAILNET_HOST="$(tr -d '[:space:]' < "$SUPPORT/tailnet-host")"; fi
if [ -n "${LH_TAILNET_HOST:-}" ]; then HOSTS="$HOSTS,$LH_TAILNET_HOST"; fi
LOGIN="${LH_TAILSCALE_LOGIN:-}"

# Values go into an XML plist: refuse anything that could break out of a <string>.
case "$PORT" in ''|*[!0-9]*) echo "LH_PORT must be digits" >&2; exit 1;; esac
for value in "$APP" "$HOME" "$HOSTS" "$LOGIN"; do
	case "$value" in *[\<\>\&\"\'\`]*|*$'\n'*) echo "unsupported character in: $value" >&2; exit 1;; esac
done

BIN="$APP/Contents/MacOS/LearnHarness"
SERVER="$APP/Contents/Resources/server/standalone/server.js"
GUARD="$APP/Contents/Resources/server-title-guard.cjs"
[ -x "$BIN" ] || { echo "LearnHarness app not found at $APP (set LH_APP)" >&2; exit 1; }
[ -f "$SERVER" ] || { echo "bundled server missing: $SERVER" >&2; exit 1; }
[ -f "$GUARD" ] || { echo "title guard missing: $GUARD" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
( umask 077; mkdir -p "$SUPPORT" ); chmod 700 "$SUPPORT"
# A short or garbage token would make the server refuse to start: replace it.
if [ ! -f "$TOKEN_FILE" ] || [ "$(wc -c < "$TOKEN_FILE" | tr -d ' ')" -lt 32 ]; then
	( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" )
fi
chmod 600 "$TOKEN_FILE"

{
cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BIN</string>
		<string>--require</string>
		<string>$GUARD</string>
		<string>$SERVER</string>
	</array>
	<key>WorkingDirectory</key><string>$APP/Contents/Resources/server/standalone</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>ELECTRON_RUN_AS_NODE</key><string>1</string>
		<key>NODE_ENV</key><string>production</string>
		<key>PORT</key><string>$PORT</string>
		<key>HOSTNAME</key><string>127.0.0.1</string>
		<key>LH_DATA_DIR</key><string>$SUPPORT/data</string>
		<key>LH_AUTH_FILE</key><string>$SUPPORT/auth.json</string>
		<key>LH_ACCESS_TOKEN_FILE</key><string>$TOKEN_FILE</string>
		<key>LH_ACCESS_ALLOWED_HOSTS</key><string>$HOSTS</string>
EOF
if [ -n "$LOGIN" ]; then
	printf '\t\t<key>LH_ACCESS_TAILSCALE_LOGIN</key><string>%s</string>\n' "$LOGIN"
fi
cat <<EOF
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG</string>
	<key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
} > "$PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"

if [ "${LH_SERVICE_DRY_RUN:-}" = "1" ]; then
	echo "dry run: wrote $PLIST"
	exit 0
fi

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
# bootout is asynchronous: bootstrap right after can fail with "Input/output error". Retry.
for attempt in 1 2 3 4 5 6; do
	sleep 1
	if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then break; fi
	[ "$attempt" = 6 ] && { launchctl bootstrap "gui/$UID_NUM" "$PLIST"; }
done
launchctl kickstart -k "gui/$UID_NUM/$LABEL"
echo "LearnHarness service installed and started (port $PORT)."
echo "Log: $LOG"
echo "Access token file: $TOKEN_FILE"
