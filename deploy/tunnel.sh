#!/usr/bin/env bash
# The zero-cost path: run the sandbox on this machine and expose it through a Cloudflare
# quick tunnel (https://<random>.trycloudflare.com). No account, no AWS. It lives only as
# long as this script and the machine stay up.
#
#   deploy/tunnel.sh                 # container (builds the image), then the tunnel
#   deploy/tunnel.sh --node          # `npm run sandbox` instead of Docker
#   deploy/tunnel.sh --replay        # don't pass MODEL_API_KEY: every command replays
#   deploy/tunnel.sh --check         # start locally, check /health and /try, stop. No tunnel.
#
# The sandbox binds to 127.0.0.1 only; cloudflared dials out, so nothing listens publicly.
# AUREN_TRUST_PROXY=1: Cloudflare's edge is the one proxy that appends the visitor's address
# to X-Forwarded-For (cloudflared and Docker's port forward add nothing), so the last entry
# is believed and a visitor can't forge theirs.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-8790}                 # not 8787, so it never collides with your real Core
IMAGE=${IMAGE:-auren-sandbox:local}
NAME=auren-sandbox-tunnel
ENV_FILE=${ENV_FILE:-$ROOT/.env}

MODE=docker REPLAY=false CHECK=false
for arg in "$@"; do
  case $arg in
    --node) MODE=node ;;
    --docker) MODE=docker ;;
    --replay) REPLAY=true ;;
    --check) CHECK=true ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

[[ $CHECK == true ]] || command -v cloudflared >/dev/null || die "needs cloudflared (brew install cloudflared)"
command -v curl >/dev/null || die "needs curl"

export AUREN_SANDBOX=true HOST=127.0.0.1 PORT AUREN_TRUST_PROXY=1
export AUREN_SANDBOX_TOKEN_BUDGET=${AUREN_SANDBOX_TOKEN_BUDGET:-200000}
export AUREN_TOKEN_LIMIT=${AUREN_TOKEN_LIMIT:-250000}

PID=""
cleanup() {
  if [[ $MODE == docker ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  if [[ -n $PID ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

if [[ $MODE == docker ]]; then
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker isn't running (or use --node)"
  say "Building $IMAGE"
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
  KEY_ARGS=()
  if [[ $REPLAY != true && -f $ENV_FILE ]]; then
    # Only this one line of .env, into this shell's environment; `-e NAME` passes it by name,
    # so the value is never on a command line. The rest of .env never reaches the container.
    MODEL_API_KEY=$(grep -E '^[[:space:]]*(export[[:space:]]+)?MODEL_API_KEY=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)
    MODEL_API_KEY=${MODEL_API_KEY#\"}; MODEL_API_KEY=${MODEL_API_KEY%\"}
    MODEL_API_KEY=${MODEL_API_KEY#\'}; MODEL_API_KEY=${MODEL_API_KEY%\'}
    if [[ -n $MODEL_API_KEY ]]; then export MODEL_API_KEY; KEY_ARGS=(-e MODEL_API_KEY); fi
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  say "Starting the container on 127.0.0.1:$PORT"
  docker run -d --name "$NAME" --read-only --cap-drop ALL --security-opt no-new-privileges \
    -p "127.0.0.1:$PORT:8080" -e AUREN_TRUST_PROXY \
    -e AUREN_SANDBOX_TOKEN_BUDGET -e AUREN_TOKEN_LIMIT ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$IMAGE" >/dev/null
  unset MODEL_API_KEY
else
  command -v node >/dev/null || die "needs Node 24+"
  [[ -d $ROOT/core/node_modules ]] || die "run 'cd core && npm ci' first"
  say "Starting npm run sandbox on 127.0.0.1:$PORT"
  # What `npm run sandbox` runs, minus npm, so the PID is node's. Variables set here win
  # over .env, and sandbox mode reads nothing from .env but MODEL_API_KEY.
  if [[ $REPLAY == true ]]; then
    (cd "$ROOT/core" && MODEL_API_KEY="" exec node src/index.ts) &
  else
    (cd "$ROOT/core" && exec node --env-file-if-exists=../.env src/index.ts) &
  fi
  PID=$!
fi

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
HEALTH=$(curl -fsS "http://127.0.0.1:$PORT/health") || {
  [[ $MODE == docker ]] && docker logs "$NAME" 2>&1 | tail -20
  die "the sandbox didn't come up on :$PORT"
}
say "Local: http://127.0.0.1:$PORT/try  $HEALTH"

if [[ $CHECK == true ]]; then
  curl -fsS -o /dev/null -w '  /try %{http_code}, %{size_download} bytes\n' "http://127.0.0.1:$PORT/try"
  curl -s -o /dev/null -w '  /v1/events %{http_code} (refused, as it should be)\n' "http://127.0.0.1:$PORT/v1/events"
  say "Check passed; stopping (no tunnel was opened)"
  exit 0
fi

say "Opening a Cloudflare quick tunnel. Give judges https://<the host it prints>/try. Ctrl-C stops both."
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
