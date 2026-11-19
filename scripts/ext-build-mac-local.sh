#!/usr/bin/env bash
# Local, unsigned macOS (Apple Silicon) build of Revised LearnHarness.
#   scripts/ext-build-mac-local.sh            build into dist/mac-arm64/LearnHarness.app
#   scripts/ext-build-mac-local.sh --install  also ad-hoc sign it and copy it to /Applications
#   (with --install the always-on service, if installed, is restarted onto the new build)
# This is not the maintainer's signed/notarized path (`npm run desktop:dist`, which needs their
# Apple team and keychain profile). The app is ad-hoc signed: macOS may ask you to allow it.
# Video: if build/manim-runtime exists (scripts/manim-runtime/build.sh) it is shipped inside the app;
# otherwise the video tool is simply not offered.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null || true; fi
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
APP=dist/mac-arm64/LearnHarness.app

echo "== clean"; rm -rf dist .next/standalone
echo "== next build"; npx next build >/dev/null
git checkout -- AGENTS.md next-env.d.ts 2>/dev/null || true   # next build rewrites them
echo "== provider smoke"; node scripts/smoke-provider-runtime.mjs >/dev/null
echo "== drop traced dev data and secrets from the build output (not from the repo)"
rm -rf .next/standalone/data .next/standalone/auth.json
rm -f .next/standalone/.env* .next/standalone/*-credentials.json*
echo "== build and smoke the server"; node scripts/build-server.mjs; node scripts/smoke-server.mjs
echo "== electron-builder (unsigned, dir)"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir \
  -c.mac.notarize=false -c.mac.identity=null -c.mac.hardenedRuntime=false
echo "== built: $APP"

if [ "${1:-}" = "--install" ]; then
  find "$APP" \( -name "auth.json" -o -name "*-credentials.json*" -o -path "*/standalone/data" \) | head || true
  codesign --force --deep --sign - "$APP"
  LABEL="org.revisedlearnharness.app"; SERVICE_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  # The service runs from inside the app bundle: stop it before the bundle is replaced.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  osascript -e 'quit app "LearnHarness"' || true; sleep 3
  rm -rf /Applications/LearnHarness.app && cp -R "$APP" /Applications/LearnHarness.app
  if [ -f "$SERVICE_PLIST" ]; then
    if launchctl bootstrap "gui/$(id -u)" "$SERVICE_PLIST" && launchctl kickstart -k "gui/$(id -u)/$LABEL"; then
      echo "== service restarted"
    else
      echo "== service restart failed: the app will try again when it opens"
    fi
  else
    echo "== service not installed yet: run scripts/service/install.sh"
  fi
  open /Applications/LearnHarness.app
  echo "== installed to /Applications"
fi
