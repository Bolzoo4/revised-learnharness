# iOS app (Capacitor shell)

`ios-shell/` is a thin native iOS app: a WKWebView that opens the always-on service over Tailscale (`https://<mac>.<tailnet>.ts.net:<port>`, see `docs/service.md`). It contains no copy of the web app, so a service update reaches the phone with no reinstall. The Mac must be on, signed in, and running Tailscale; the Electron window need not be open.

The service address is personal and is never committed: `capacitor.config.ts` reads it from `~/Library/Application Support/LearnHarness/tailnet-host` (written by `scripts/service/serve.sh on`), or from `LH_SHELL_HOST=<host>:<port>`. `cap sync` writes it into generated files that are git-ignored.

## Build and install on a phone

Needs Xcode and an Apple ID signed in to Xcode. A free account signs the app for 7 days: after that it stops opening and must be reinstalled the same way, with the phone connected by cable.

```bash
cd ios-shell && npm install
npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<device id>' -derivedDataPath ios/DerivedData -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your team id> CODE_SIGN_STYLE=Automatic \
  PRODUCT_BUNDLE_IDENTIFIER="$(../scripts/service/label.sh)" build
xcrun devicectl device install app --device <device id> ios/DerivedData/Build/Products/Debug-iphoneos/App.app
```

Microphone: the app asks for the microphone for dictation and voice mode, with the text in `Info.plist` (`NSMicrophoneUsageDescription`). WKWebView needs no extra capture flag: the usage string is what iOS shows. A change to `Info.plist` takes effect only in a build that is installed again, so the phone app must be reinstalled (the command below) before the prompt appears.

Device ids: `xcrun devicectl list devices`. The team id is not committed (find it in Xcode, Settings, Accounts). On the phone, trust the developer once in Settings, General, VPN & Device Management.

## Sign in

Run `scripts/service/pair.sh` on the Mac, then paste the printed link (or only the code after `#`) into **Pairing link or code** on the app's sign-in page. The session cookie lives in the app and survives closing it.

## Simulator

The simulator has no Tailscale. Sync to the Mac itself and build for the simulator:

```bash
LH_SHELL_HOST=127.0.0.1:47890 npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ios/DerivedData build CODE_SIGNING_ALLOWED=NO
```

Run `npx cap sync ios` again without `LH_SHELL_HOST` before building for a real phone.
