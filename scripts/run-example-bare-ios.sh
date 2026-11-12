#!/usr/bin/env bash
# Runs the bare React Native app's checks on an iOS simulator against the local backend.
# Same steps as scripts/run-example-ios.sh, reporting to example/reports/bare-ios-*.json.
# Env: SIMULATOR_UDID (default: first available iPhone), TIMEOUT_S (default 300).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/example-bare"
REPORTS="$ROOT/example/reports"
TMP="$ROOT/.tmp"
BUNDLE_ID="com.synclaire.bare"
TIMEOUT_S="${TIMEOUT_S:-300}"
mkdir -p "$TMP"

UDID="${SIMULATOR_UDID:-$(xcrun simctl list devices available | grep -m1 -oE 'iPhone[^(]*\(([0-9A-F-]{36})\)' | grep -oE '[0-9A-F-]{36}')}"
[ -n "$UDID" ] || { echo "no iPhone simulator available" >&2; exit 1; }
xcrun simctl bootstatus "$UDID" -b >/dev/null

bash "$ROOT/scripts/backend-up.sh" >/dev/null
node --import tsx "$ROOT/scripts/prepare-watermelon-fixture.ts"

# Restart so the server is the current script (report filenames include the bare prefix).
if [ -f "$TMP/control.pid" ]; then
  kill "$(cat "$TMP/control.pid")" 2>/dev/null || true
  rm -f "$TMP/control.pid"
fi
if curl -sf http://127.0.0.1:8799/config >/dev/null; then
  echo "port 8799 is in use by a control server this script did not start" >&2
  exit 1
fi
nohup node --import tsx "$ROOT/scripts/device-control-server.ts" --autorun \
  </dev/null >"$TMP/control.log" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
echo $! >"$TMP/control.pid"
sleep 2

(cd "$APP_DIR/ios" && pod install)
(cd "$APP_DIR/ios" && xcodebuild -workspace SynclaireBare.xcworkspace -scheme SynclaireBare \
  -configuration Release -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath build build \
  >"$TMP/xcode-bare.log" 2>&1) || { tail -40 "$TMP/xcode-bare.log"; exit 1; }
APP="$APP_DIR/ios/build/Build/Products/Release-iphonesimulator/SynclaireBare.app"

rm -f "$REPORTS"/bare-ios-*.json
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

for _ in $(seq 1 $((TIMEOUT_S / 2))); do
  [ -f "$REPORTS/bare-ios-bench.json" ] && break
  sleep 2
done
[ -f "$REPORTS/bare-ios-bench.json" ] || { echo "timed out waiting for reports" >&2; exit 1; }

status=0
for f in "$REPORTS"/bare-ios-*.json; do
  node -e '
    const r = require(process.argv[1]);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.prefix ? r.prefix + " " : ""}${r.platform} ${r.name}`);
    for (const l of r.lines) console.log(`     ${l}`);
    process.exit(r.ok ? 0 : 1);
  ' "$f" || status=1
done
exit $status
