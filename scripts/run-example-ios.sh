#!/usr/bin/env bash
# Runs the example app's checks on an iOS simulator against the local backend:
#   1. reseeds the backend (scripts/backend-up.sh) and builds the WatermelonDB fixtures
#   2. starts the device control server in autorun mode (if not already running)
#   3. builds the app (Release, JS embedded, so no dev-client prompt), installs and launches it
#   4. waits for the reports in example/reports/ and exits non-zero if any check failed
# Env: SIMULATOR_UDID (default: first available iPhone), TIMEOUT_S (default 300).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/example"
REPORTS="$EXAMPLE/reports"
TMP="$ROOT/.tmp"
BUNDLE_ID="com.synclaire.example"
TIMEOUT_S="${TIMEOUT_S:-300}"
mkdir -p "$TMP"

UDID="${SIMULATOR_UDID:-$(xcrun simctl list devices available | grep -m1 -oE 'iPhone[^(]*\(([0-9A-F-]{36})\)' | grep -oE '[0-9A-F-]{36}')}"
[ -n "$UDID" ] || { echo "no iPhone simulator available" >&2; exit 1; }
xcrun simctl bootstatus "$UDID" -b >/dev/null

bash "$ROOT/scripts/backend-up.sh" >/dev/null
node --import tsx "$ROOT/scripts/prepare-watermelon-fixture.ts"

if ! curl -sf http://127.0.0.1:8799/config >/dev/null; then
  nohup node --import tsx "$ROOT/scripts/device-control-server.ts" --autorun \
    </dev/null >"$TMP/control.log" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
  echo $! >"$TMP/control.pid"
  sleep 2
fi

[ -d "$EXAMPLE/ios" ] || (cd "$EXAMPLE" && CI=1 npx expo prebuild --platform ios)
(cd "$EXAMPLE/ios" && xcodebuild -workspace SynclaireExample.xcworkspace -scheme SynclaireExample \
  -configuration Release -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath build build \
  >"$TMP/xcode-release.log" 2>&1) || { tail -40 "$TMP/xcode-release.log"; exit 1; }
APP="$EXAMPLE/ios/build/Build/Products/Release-iphonesimulator/SynclaireExample.app"

rm -rf "$REPORTS"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

for _ in $(seq 1 $((TIMEOUT_S / 2))); do
  [ -f "$REPORTS/ios-bench.json" ] && break
  sleep 2
done
[ -f "$REPORTS/ios-bench.json" ] || { echo "timed out waiting for reports" >&2; exit 1; }

status=0
for f in "$REPORTS"/ios-*.json; do
  node -e '
    const r = require(process.argv[1]);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.platform} ${r.name}`);
    for (const l of r.lines) console.log(`     ${l}`);
    process.exit(r.ok ? 0 : 1);
  ' "$f" || status=1
done
exit $status
