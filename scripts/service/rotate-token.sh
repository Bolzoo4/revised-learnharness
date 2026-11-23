#!/usr/bin/env bash
# Replace the access token. Every existing session cookie stops working.
set -euo pipefail
LABEL="$("$(dirname "$0")/label.sh")"
TOKEN_FILE="$HOME/Library/Application Support/LearnHarness/access-token"
[ -f "$TOKEN_FILE" ] || { echo "no token yet: run scripts/service/install.sh first" >&2; exit 1; }
rm -f "$TOKEN_FILE.tmp"
( umask 077; openssl rand -hex 32 > "$TOKEN_FILE.tmp" )
chmod 600 "$TOKEN_FILE.tmp"
mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
if [ "${LH_SERVICE_DRY_RUN:-}" != "1" ]; then
	launchctl kickstart -k "gui/$(id -u)/$LABEL" || echo "service not running: the new token applies when it starts" >&2
fi
echo "Token rotated. Sign in again on every device."
