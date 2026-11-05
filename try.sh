#!/usr/bin/env bash
# Try Auren on your own machine: the /try sandbox on a fictional workspace, with a simulated
# phone, watch and glasses. Nothing reaches a real account or device.
#
#   ./try.sh                 Docker if it's running, otherwise Node 24 from this checkout
#   ./try.sh --node          always use Node (needs Node 24+)
#   MODEL_API_KEY=… ./try.sh live Muse with your own Meta key; without one, every example replays
#
# Then open http://localhost:8080/try and press "Start the 3-minute judge tour".
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8080}
IMAGE=ghcr.io/sandeepvijayarao09/auren-sandbox:latest
URL="http://localhost:$PORT/try"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

open_when_ready() {
  for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  say "Auren is ready: $URL"
  command -v open >/dev/null && open "$URL" || command -v xdg-open >/dev/null && xdg-open "$URL" || true
}

engine=$([[ -n "${MODEL_API_KEY:-}" ]] && echo "live Muse (your key)" || echo "replay (no key needed)")

if [[ "${1:-}" != "--node" ]] && command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  say "Running $IMAGE · $engine · Ctrl-C stops it"
  open_when_ready &
  # The key, if any, is passed by name so it never appears on the command line.
  exec docker run --rm --pull always -p "127.0.0.1:$PORT:8080" -e MODEL_API_KEY "$IMAGE"
fi

command -v node >/dev/null || die "needs Docker (running) or Node 24+: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
(( major >= 24 )) || die "needs Node 24 or newer (found $(node -v)), or Docker"

cd "$ROOT/core"
[[ -d node_modules ]] || { say "Installing Core's dependencies (once)"; npm ci --omit=dev --no-audit --no-fund; }
say "Running the sandbox with Node · $engine · Ctrl-C stops it"
open_when_ready &
PORT=$PORT HOST=127.0.0.1 AUREN_SANDBOX=true exec node src/index.ts
