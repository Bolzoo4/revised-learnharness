#!/usr/bin/env bash
# Print a pairing link (and a QR when qrencode is installed) for the phone.
#   scripts/service/pair.sh
# The link holds a one-time code valid for five minutes, never the access token.
set -euo pipefail

PORT="${LH_PORT:-47890}"
SUPPORT="$HOME/Library/Application Support/LearnHarness"
TOKEN_FILE="$SUPPORT/access-token"
HOST_FILE="$SUPPORT/tailnet-host"
BASE="http://127.0.0.1:$PORT"

[ -s "$HOST_FILE" ] || { echo "Not published on the tailnet yet: run scripts/service/serve.sh on first" >&2; exit 1; }
[ -s "$TOKEN_FILE" ] || { echo "no token yet: run scripts/service/install.sh first" >&2; exit 1; }

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# The token travels on stdin (printf is a builtin), never in a process argument list.
printf '{"token":"%s"}' "$(cat "$TOKEN_FILE")" | curl -fsS -c "$JAR" -o /dev/null \
	-H "Origin: $BASE" -H "Content-Type: application/json" --data-binary @- "$BASE/api/access/signin" \
	|| { echo "The service refused the sign-in (is it running? is the token current?)" >&2; exit 1; }

RESPONSE="$(curl -fsS -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/access/pairing")" \
	|| { echo "The service did not create a pairing code" >&2; exit 1; }
CODE="$(printf '%s' "$RESPONSE" | /usr/bin/plutil -extract code raw -o - -)"
[ -n "$CODE" ] || { echo "The service returned no code" >&2; exit 1; }

URL="https://$(cat "$HOST_FILE")/pair#$CODE"
if command -v qrencode >/dev/null 2>&1; then
	qrencode -t ANSIUTF8 "$URL"
else
	echo "(install qrencode to see a QR here: brew install qrencode)"
fi
echo "$URL"
echo "Valid for 5 minutes, one use. Scan it, or open the link on the phone."
