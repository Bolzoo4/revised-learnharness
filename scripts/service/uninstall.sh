#!/usr/bin/env bash
# Stop and remove the LearnHarness service. Keeps the access token and all data.
set -euo pipefail
LABEL="org.revisedlearnharness.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "${LH_SERVICE_DRY_RUN:-}" != "1" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
rm -f "$PLIST"
echo "Service removed. The access token and your data were kept."
