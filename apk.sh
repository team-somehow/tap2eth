#!/usr/bin/env bash
# Build the phone app with the backend URL from .env built in. The APK needs no laptop, USB or Metro.
#   ./apk.sh                    build ./tap2eth.apk (switch network in its secret settings)
#   ./apk.sh whitechain         build ./tap2eth-whitechain.apk: an app fixed to Whitechain
#   ./apk.sh sepolia            build ./tap2eth-sepolia.apk: an app fixed to Ethereum Sepolia (installs next to the other one)
#   add `install` to install on the phone connected over USB, e.g. ./apk.sh sepolia install
# The fixed apps use the /whitechain and /sepolia routes, so the backend must be started with ./backend.sh both.
# The URL is fixed inside the APK: after changing RELAYER_URL, build and share it again.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env yet. Run: cp .env.example .env  and fill it in."; exit 1; }
set -a; . ./.env; set +a
[ -n "${RELAYER_URL:-}" ] || { echo "Set RELAYER_URL in .env first."; exit 1; }
case "$RELAYER_URL" in https://*) ;; *) echo "Note: RELAYER_URL isn't https; phones off your network won't reach it." ;; esac

VARIANT=""; case "${1:-}" in whitechain|sepolia) VARIANT="$1"; shift ;; esac
GRADLE_PROPS=""; OUT=tap2eth.apk
if [ -n "$VARIANT" ]; then
  export EXPO_PUBLIC_NETWORK="$VARIANT"
  OUT="tap2eth-$VARIANT.apk"
  # A different application id and name, so both apps can be installed on one phone.
  [ "$VARIANT" = sepolia ] && GRADLE_PROPS="-Ptap2ethAppId=app.tap2eth.sepolia -Ptap2ethAppName=Tap2ETH-Sepolia" || GRADLE_PROPS="-Ptap2ethAppId=app.tap2eth.whitechain -Ptap2ethAppName=Tap2ETH-Whitechain"
else
  unset EXPO_PUBLIC_NETWORK
fi
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
  -PreactNativeArchitectures=arm64-v8a $GRADLE_PROPS --console=plain -q)
APK=mobile/android/app/build/outputs/apk/release/app-release.apk
[ "$APK" -nt "$STARTED" ] || { echo "No fresh APK was built. Run (cd mobile/android && ./gradlew assembleRelease) to see why."; exit 1; }
cp "$APK" "$OUT"
echo "Built ./$OUT ($(du -h "$OUT" | cut -f1)) for $RELAYER_URL"

if [ "${1:-}" = install ]; then
  command -v adb >/dev/null || { echo "adb isn't installed."; exit 1; }
  adb install -r "$OUT" && echo "Installed on the connected phone."
fi
