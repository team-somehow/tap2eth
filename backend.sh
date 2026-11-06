#!/usr/bin/env bash
# Start the backend: the relayer on :8787 plus an ngrok tunnel, so phones and the Pi reach it from any network.
# Usage: ./backend.sh        (Ctrl-C stops both)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env yet. Run: cp .env.example .env  and fill it in."; exit 1; }
set -a; . ./.env; set +a
export PATH="/opt/homebrew/bin:$PATH"
PORT=8787

# Without a token address the relayer would deploy a fresh test token on the live chain.
[ -n "${TOKEN_ADDRESS:-}" ] || { echo "Set TOKEN_ADDRESS in .env first."; exit 1; }
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something already listens on port $PORT (an old backend?). Stop it, then run this again:"
  lsof -iTCP:$PORT -sTCP:LISTEN
  exit 1
fi
command -v ngrok >/dev/null || { echo "ngrok isn't installed: brew install ngrok"; exit 1; }

pids=()
trap 'echo; echo "Stopping backend..."; kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null' EXIT INT TERM

echo "Starting relayer on :$PORT..."
(cd relayer && TOKEN_ADDRESS="$TOKEN_ADDRESS" RECOVERY_DELAY="${RECOVERY_DELAY:-86400}" exec node --env-file-if-exists=.env server.v2.js) &
pids+=($!)
for _ in $(seq 1 60); do
  lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
  kill -0 "${pids[0]}" 2>/dev/null || { echo "The relayer stopped while starting. See the messages above."; exit 1; }
  sleep 1
done

echo "Starting ngrok${NGROK_DOMAIN:+ on $NGROK_DOMAIN}..."
ngrok http "$PORT" ${NGROK_DOMAIN:+--url="$NGROK_DOMAIN"} --log=stdout --log-level=warn > /tmp/tap2eth-ngrok.log 2>&1 &
pids+=($!)
URL=""
for _ in $(seq 1 20); do
  URL=$(curl -s localhost:4040/api/tunnels 2>/dev/null | python3 -c 'import sys, json
try: print(next(t["public_url"] for t in json.load(sys.stdin)["tunnels"] if t["public_url"].startswith("https")))
except Exception: pass' || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "ngrok didn't start. Its log:"; cat /tmp/tap2eth-ngrok.log; exit 1; }

echo
echo "  Backend  http://localhost:$PORT"
echo "  Public   $URL"
if [ "${URL%/}" != "${RELAYER_URL%/}" ]; then
  echo
  echo "  ! RELAYER_URL in .env is ${RELAYER_URL:-empty}, but the tunnel is $URL."
  echo "    Put $URL in .env, then run ./pi.sh url and rebuild the app with ./apk.sh"
fi
echo
echo "Running. Ctrl-C to stop."
wait "${pids[0]}"
