#!/usr/bin/env bash
# Build the phone app with the backend URL from .env built in. The APK needs no laptop, USB or Metro.
#   ./apk.sh            build ./tap2eth.apk (share it to the phones)
#   ./apk.sh install    build, then install on the phone connected over USB
# The URL is fixed inside the APK: after changing RELAYER_URL, build and share it again.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env yet. Run: cp .env.example .env  and fill it in."; exit 1; }
set -a; . ./.env; set +a
[ -n "${RELAYER_URL:-}" ] || { echo "Set RELAYER_URL in .env first."; exit 1; }
case "$RELAYER_URL" in https://*) ;; *) echo "Note: RELAYER_URL isn't https; phones off your network won't reach it." ;; esac

export EXPO_PUBLIC_RELAYER_URL="$RELAYER_URL"
export PATH="/opt/homebrew/bin:$PATH"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

echo "Building the app for $RELAYER_URL..."
STARTED=$(mktemp); trap 'rm -f "$STARTED"' EXIT
# The URL is baked into the JS bundle, but Gradle doesn't see it as an input and would reuse an old bundle:
# rebuild just that bundle (--rerun) with an empty Metro cache. The native code stays cached, so this is quick.
rm -rf "${TMPDIR:-/tmp}"/metro-cache
(cd mobile/android && ./gradlew createBundleReleaseJsAndAssets --rerun assembleRelease \
  -PreactNativeArchitectures=arm64-v8a --console=plain -q)
APK=mobile/android/app/build/outputs/apk/release/app-release.apk
[ "$APK" -nt "$STARTED" ] || { echo "No fresh APK was built. Run (cd mobile/android && ./gradlew assembleRelease) to see why."; exit 1; }
cp "$APK" tap2eth.apk
echo "Built ./tap2eth.apk ($(du -h tap2eth.apk | cut -f1)) for $RELAYER_URL"

if [ "${1:-}" = install ]; then
  command -v adb >/dev/null || { echo "adb isn't installed."; exit 1; }
  adb install -r tap2eth.apk && echo "Installed on the connected phone."
fi
