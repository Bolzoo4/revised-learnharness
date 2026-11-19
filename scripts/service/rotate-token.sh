#!/usr/bin/env bash
# Replace the access token. Every existing session cookie stops working.
set -euo pipefail
LABEL="org.revisedlearnharness.app"
TOKEN_FILE="$HOME/Library/Application Support/LearnHarness/access-token"
[ -f "$TOKEN_FILE" ] || { echo "no token yet: run scripts/service/install.sh first" >&2; exit 1; }
( umask 077; openssl rand -hex 32 > "$TOKEN_FILE.tmp" )
chmod 600 "$TOKEN_FILE.tmp"
mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
if [ "${LH_SERVICE_DRY_RUN:-}" != "1" ]; then
	launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi
echo "Token rotated. Sign in again on every device."
