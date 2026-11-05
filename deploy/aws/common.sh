# Shared settings for deploy/aws/*.sh. Sourced, not run. Every value can be overridden
# from the environment, e.g. `AWS_REGION=us-west-2 POWER=micro deploy/aws/deploy.sh`.
# shellcheck shell=bash

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}
SERVICE=${SERVICE:-auren-sandbox}            # Lightsail container service name (also its URL prefix)
LABEL=${LABEL:-sandbox}                      # image label in the service's own registry
POWER=${POWER:-nano}                         # nano: 0.25 vCPU, 512 MB. The sandbox idles at ~92 MB, ~105 MB with 45 visitors
SCALE=${SCALE:-1}                            # nodes; >1 would split visitors' in-memory worlds across nodes
SSM_PARAM=${SSM_PARAM:-/auren/sandbox/MODEL_API_KEY}
BUDGET_NAME=${BUDGET_NAME:-auren-sandbox}
IMAGE=${IMAGE:-auren-sandbox:deploy}
ENV_FILE=${ENV_FILE:-$ROOT/.env}

# The sandbox's own caps (core/src/config.ts). The live engine spends at most TOKEN_BUDGET
# tokens and then replays; TOKEN_LIMIT is the spend guard's hard stop, a backstop above it.
TOKEN_BUDGET=${TOKEN_BUDGET:-200000}
TOKEN_LIMIT=${TOKEN_LIMIT:-250000}
SANDBOX_RPM=${SANDBOX_RPM:-6}
SANDBOX_DAILY=${SANDBOX_DAILY:-60}
SANDBOX_MAX_VISITORS=${SANDBOX_MAX_VISITORS:-50}
AUREN_TZ=${AUREN_TZ:-America/Los_Angeles}
# Lightsail's managed load balancer is the one proxy in front of the container: it appends
# the address it saw to X-Forwarded-For, so exactly one entry (the last) is trustworthy.
TRUST_PROXY=${TRUST_PROXY:-1}

export AWS_PAGER=""
AWS=(aws --region "$REGION")

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

need() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "needs $t on PATH"; done
}

whoami_aws() {
  "${AWS[@]}" sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null \
    || die "no AWS credentials. Run 'aws configure' or 'aws sso login' first."
}

# Exists? (exit status only; prints nothing.)
service_exists() {
  "${AWS[@]}" lightsail get-container-services --service-name "$SERVICE" --query 'containerServices[0].state' --output text >/dev/null 2>&1
}

# Only ever select non-secret fields: a full get-container-services response includes the
# deployment's environment, which holds MODEL_API_KEY.
service_field() {
  "${AWS[@]}" lightsail get-container-services --service-name "$SERVICE" --query "containerServices[0].$1" --output text
}
