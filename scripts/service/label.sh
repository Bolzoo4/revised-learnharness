#!/usr/bin/env bash
# Prints the app id used as the launchd label (and as the iOS bundle id in local builds).
# Default: org.revisedlearnharness.app. To use another id on this Mac only, put it alone in
#   ~/Library/Application Support/LearnHarness/app-id
# The file is outside the repository, so the id never reaches a commit.
f="$HOME/Library/Application Support/LearnHarness/app-id"
v=""
[ -r "$f" ] && v="$(tr -d '[:space:]' < "$f")"
case "$v" in
  ""|*[!A-Za-z0-9.-]*) echo "org.revisedlearnharness.app" ;;
  *) echo "$v" ;;
esac
