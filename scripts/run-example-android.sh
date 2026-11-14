#!/usr/bin/env bash
# Runs the example app's checks on an Android emulator against the local backend:
#   1. boots the AVD if no device is online
#   2. reseeds the backend (scripts/backend-up.sh) and builds the WatermelonDB fixtures
#   3. starts the device control server in autorun mode (if not already running)
#   4. builds a Release APK (JS embedded, so no dev-client prompt), installs and launches it
#   5. waits for the reports in example/reports/ and exits non-zero if any check failed
# Env: ANDROID_AVD (default Pixel_API_34), ANDROID_SERIAL, ANDROID_ABIS (default arm64-v8a),
#      TIMEOUT_S (default 300, after the build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/example"
REPORTS="$EXAMPLE/reports"
TMP="$ROOT/.tmp"
PACKAGE="com.synclaire.example"
TIMEOUT_S="${TIMEOUT_S:-300}"
AVD="${ANDROID_AVD:-Pixel_API_34}"
ABIS="${ANDROID_ABIS:-arm64-v8a}"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_HOME
# A sandboxed shell points GRADLE_USER_HOME at an empty cache, and the wrapper then
# downloads Gradle through one GitHub address that does not connect.
case "${GRADLE_USER_HOME:-}" in
  *cursor-sandbox-cache*) export GRADLE_USER_HOME="${HOME}/.gradle" ;;
esac
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
mkdir -p "$TMP"

[ -x "$ADB" ] || { echo "adb not found at $ADB" >&2; exit 1; }
[ -x "$EMULATOR" ] || { echo "emulator not found at $EMULATOR" >&2; exit 1; }

online_serials() {
  "$ADB" devices | awk 'NR>1 && $2=="device" {print $1}'
}

if [ -z "${ANDROID_SERIAL:-}" ]; then
  serials="$(online_serials)"
  count="$(printf '%s\n' "$serials" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    nohup "$EMULATOR" -avd "$AVD" -netdelay none -netspeed full \
      </dev/null >"$TMP/emulator.log" 2>&1 &
    echo $! >"$TMP/emulator.pid"
    "$ADB" wait-for-device
  elif [ "$count" -eq 1 ]; then
    ANDROID_SERIAL="$serials"
  else
    echo "multiple devices online; set ANDROID_SERIAL" >&2
    exit 1
  fi
fi
if [ -n "${ANDROID_SERIAL:-}" ]; then
  export ANDROID_SERIAL
fi

booted=""
for _ in $(seq 1 90); do
  booted="$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$booted" = "1" ] && break
  sleep 2
done
[ "$booted" = "1" ] || { echo "emulator did not finish booting" >&2; exit 1; }
if [ -z "${ANDROID_SERIAL:-}" ]; then
  ANDROID_SERIAL="$(online_serials | head -1)"
  [ -n "$ANDROID_SERIAL" ] || { echo "no device after boot" >&2; exit 1; }
  export ANDROID_SERIAL
fi

bash "$ROOT/scripts/backend-up.sh" >/dev/null
node --import tsx "$ROOT/scripts/prepare-watermelon-fixture.ts"

if ! curl -sf http://127.0.0.1:8799/config >/dev/null; then
  nohup node --import tsx "$ROOT/scripts/device-control-server.ts" --autorun \
    </dev/null >"$TMP/control.log" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
  echo $! >"$TMP/control.pid"
  sleep 2
fi

[ -d "$EXAMPLE/android" ] || (cd "$EXAMPLE" && CI=1 npx expo prebuild --platform android)
# The wrapper's default 10s timeout is shorter than a cold download from GitHub.
sed -i '' 's/^networkTimeout=.*/networkTimeout=120000/' "$EXAMPLE/android/gradle/wrapper/gradle-wrapper.properties"
(cd "$EXAMPLE/android" && ./gradlew :app:assembleRelease -PreactNativeArchitectures="$ABIS" \
  >"$TMP/gradle-example.log" 2>&1) || { tail -40 "$TMP/gradle-example.log"; exit 1; }
APK="$EXAMPLE/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "release apk not found at $APK" >&2; exit 1; }

rm -f "$REPORTS"/android-*.json
"$ADB" uninstall "$PACKAGE" >/dev/null 2>&1 || true
"$ADB" install -r "$APK" >/dev/null
COMPONENT="$("$ADB" shell cmd package resolve-activity --brief "$PACKAGE" | tr -d '\r' | tail -1)"
"$ADB" shell am start -n "$COMPONENT" >/dev/null

for _ in $(seq 1 $((TIMEOUT_S / 2))); do
  [ -f "$REPORTS/android-bench.json" ] && break
  sleep 2
done
[ -f "$REPORTS/android-bench.json" ] || { echo "timed out waiting for reports" >&2; exit 1; }

status=0
for f in "$REPORTS"/android-*.json; do
  node -e '
    const r = require(process.argv[1]);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.platform} ${r.name}`);
    for (const l of r.lines) console.log(`     ${l}`);
    process.exit(r.ok ? 0 : 1);
  ' "$f" || status=1
done
exit $status
