#!/usr/bin/env bash
# Publish the service on the tailnet over HTTPS (Tailscale Serve, TLS-terminated TCP).
#   scripts/service/serve.sh on|off|status
# Optional environment:
#   LH_SERVE_PORT       tailnet port (default 8444; never 443, 8443 or 10000, which Funnel can publish)
#   LH_PORT             the service's loopback port (default 47890)
#   LH_TAILSCALE_BIN    the tailscale CLI (default: tailscale on PATH, else the app bundle's)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${LH_SERVE_PORT:-8444}"
SERVICE_PORT="${LH_PORT:-47890}"
SUPPORT="$HOME/Library/Application Support/LearnHarness"
HOST_FILE="$SUPPORT/tailnet-host"

case "$PORT" in ''|*[!0-9]*) echo "LH_SERVE_PORT must be digits" >&2; exit 1;; esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ] || [ "$PORT" = 443 ] || [ "$PORT" = 8443 ] || [ "$PORT" = 10000 ]; then
	echo "LH_SERVE_PORT must be 1024-65535 and not 443, 8443 or 10000" >&2; exit 1
fi

TS="${LH_TAILSCALE_BIN:-}"
if [ -z "$TS" ]; then
	if command -v tailscale >/dev/null 2>&1; then TS="$(command -v tailscale)"; else TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; fi
fi
[ -x "$TS" ] || { echo "Tailscale CLI not found (set LH_TAILSCALE_BIN)" >&2; exit 1; }

dns_name() {
	"$TS" status --json | /usr/bin/plutil -extract Self.DNSName raw -o - - | sed 's/\.$//'
}

case "${1:-}" in
	on)
		NAME="$(dns_name)"
		[ -n "$NAME" ] || { echo "could not read this machine's tailnet name (is Tailscale running and MagicDNS on?)" >&2; exit 1; }
		CURRENT="$("$TS" serve status 2>/dev/null || true)"
		if printf '%s\n' "$CURRENT" | grep -Eq ":$PORT([^0-9]|$)" && ! printf '%s\n' "$CURRENT" | grep -q "127.0.0.1:$SERVICE_PORT"; then
			echo "port $PORT is already used by another Tailscale Serve mapping; choose another with LH_SERVE_PORT" >&2; exit 1
		fi
		if ! printf '%s\n' "$CURRENT" | grep -q "127.0.0.1:$SERVICE_PORT"; then
			"$TS" serve --bg --tls-terminated-tcp="$PORT" "tcp://127.0.0.1:$SERVICE_PORT"
		fi
		mkdir -p "$SUPPORT"
		printf '%s' "$NAME:$PORT" > "$HOST_FILE"
		"$DIR/install.sh" >/dev/null
		echo "Published: https://$NAME:$PORT"
		echo "Next: scripts/service/pair.sh to pair a phone."
		;;
	off)
		"$TS" serve --tls-terminated-tcp="$PORT" off || true
		rm -f "$HOST_FILE"
		"$DIR/install.sh" >/dev/null
		echo "Unpublished port $PORT."
		;;
	status)
		if [ -s "$HOST_FILE" ]; then echo "Published: https://$(cat "$HOST_FILE")"; else echo "Not published (run scripts/service/serve.sh on)"; fi
		;;
	*) echo "usage: serve.sh on|off|status" >&2; exit 1;;
esac
