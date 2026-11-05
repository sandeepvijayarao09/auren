#!/usr/bin/env bash
# Deploys the public sandbox (/try) to an Amazon Lightsail container service and prints
# its HTTPS URL. Safe to re-run: it creates what's missing and ships a new version.
#
#   deploy/aws/deploy.sh            # asks before creating anything billable
#   deploy/aws/deploy.sh --yes      # no prompt
#   deploy/aws/deploy.sh --replay   # deploy without a key: every command replays
#
# MODEL_API_KEY: read from .env (only that line; the file is never sourced), stored as an
# SSM SecureString at $SSM_PARAM, then read back from SSM for the deployment. If .env has
# no key, the SSM copy from an earlier run is used. The key only ever travels over stdin
# pipes: never in argv, a file, a log line or this script's output.
# Lightsail has no secret injection, so the key does end up in the deployment's
# environment, readable by this account's principals via get-container-service-deployments.
# See docs/deploy.md for that trade-off and for ECS Express Mode, which injects secrets.
set -euo pipefail
source "$(dirname "$0")/common.sh"

YES=false
REPLAY=false
for arg in "$@"; do
  case $arg in
    -y|--yes) YES=true ;;
    --replay) REPLAY=true ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

need aws docker jq curl
docker info >/dev/null 2>&1 || die "Docker isn't running"

IDENTITY=$(whoami_aws)
read -r ACCOUNT ARN <<<"$IDENTITY"
PRICE=$("${AWS[@]}" lightsail get-container-service-powers --query "powers[?name=='$POWER'].price | [0]" --output text)
[[ $PRICE != None && -n $PRICE ]] || die "no Lightsail power named '$POWER' in $REGION"
MONTHLY=$(awk -v p="$PRICE" -v s="$SCALE" 'BEGIN { printf "%.2f", p * s }')

say "Plan"
cat <<EOF
  account   $ACCOUNT ($ARN)
  region    $REGION
  service   Lightsail container service '$SERVICE', power $POWER x $SCALE = \$$MONTHLY/month flat, prorated hourly
  key       $([[ $REPLAY == true ]] && echo "none (replay)" || echo "MODEL_API_KEY -> SSM SecureString $SSM_PARAM")
  caps      token budget $TOKEN_BUDGET, then replay · hard limit $TOKEN_LIMIT · $SANDBOX_RPM/min, $SANDBOX_DAILY/day per address · $SANDBOX_MAX_VISITORS visitors
  proxy     AUREN_TRUST_PROXY=$TRUST_PROXY (Lightsail's load balancer)
EOF
if [[ $YES != true ]] && ! service_exists; then
  read -r -p "Create billable resources? [y/N] " ok
  [[ $ok == [yY]* ]] || die "stopped; nothing was created"
fi

# ── 1. the key ────────────────────────────────────────────────────────────
KEY=""
if [[ $REPLAY != true ]]; then
  FROM_ENV=""
  if [[ -f $ENV_FILE ]]; then
    FROM_ENV=$(grep -E '^[[:space:]]*(export[[:space:]]+)?MODEL_API_KEY=' "$ENV_FILE" | tail -n 1 || true)
    FROM_ENV=${FROM_ENV#*=}
    FROM_ENV=${FROM_ENV%$'\r'}
    FROM_ENV=${FROM_ENV#\"}; FROM_ENV=${FROM_ENV%\"}
    FROM_ENV=${FROM_ENV#\'}; FROM_ENV=${FROM_ENV%\'}
  fi
  if [[ -n $FROM_ENV ]]; then
    say "Storing MODEL_API_KEY from $(basename "$ENV_FILE") in SSM ($SSM_PARAM)"
    printf '%s' "$FROM_ENV" | "${AWS[@]}" ssm put-parameter --name "$SSM_PARAM" --type SecureString --overwrite \
      --description "Auren sandbox: Meta Model API key (rotate after judging)" --value file:///dev/stdin --query Version --output text >/dev/null
  fi
  unset FROM_ENV
  KEY=$("${AWS[@]}" ssm get-parameter --name "$SSM_PARAM" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)
  if [[ -z $KEY || $KEY == None ]]; then
    KEY=""
    warn "no MODEL_API_KEY in $ENV_FILE or SSM: deploying in replay mode"
  fi
fi

# ── 2. the service ────────────────────────────────────────────────────────
wait_service() { # until READY or RUNNING (accepting a deployment)
  local state i
  for i in $(seq 1 90); do
    state=$(service_field state)
    case $state in
      READY|RUNNING) return 0 ;;
      PENDING|DEPLOYING|UPDATING) printf '    %s...\r' "$state"; sleep 10 ;;
      *) die "service is $state; see the Lightsail console" ;;
    esac
  done
  die "service still not ready after 15 minutes"
}

if service_exists; then
  say "Service '$SERVICE' exists ($(service_field state))"
  read -r CUR_POWER CUR_SCALE <<<"$(service_field '[power,scale]')"
  if [[ $CUR_POWER != "$POWER" || $CUR_SCALE != "$SCALE" ]]; then
    wait_service
    say "Resizing $CUR_POWER x $CUR_SCALE -> $POWER x $SCALE"
    "${AWS[@]}" lightsail update-container-service --service-name "$SERVICE" --power "$POWER" --scale "$SCALE" --query containerService.state --output text >/dev/null
  fi
else
  say "Creating service '$SERVICE' ($POWER x $SCALE)"
  "${AWS[@]}" lightsail create-container-service --service-name "$SERVICE" --power "$POWER" --scale "$SCALE" \
    --tags key=project,value=auren-sandbox --query containerService.state --output text >/dev/null
fi
wait_service

# ── 3. the image ──────────────────────────────────────────────────────────
# Lightsail runs amd64. One platform, no attestation manifests, so the push is a plain image.
say "Building $IMAGE for linux/amd64"
docker build --platform linux/amd64 --provenance=false --sbom=false -t "$IMAGE" "$ROOT"

say "Pushing to the service's registry"
read -r REG_USER REG_PASS REG_URL <<<"$("${AWS[@]}" lightsail create-container-service-registry-login \
  --query 'registryLogin.[username,password,registry]' --output text)"
REG_HOST=${REG_URL#https://}; REG_HOST=${REG_HOST%/}
trap 'docker logout "$REG_HOST" >/dev/null 2>&1 || true' EXIT
printf '%s' "$REG_PASS" | docker login --username "$REG_USER" --password-stdin "$REG_HOST" >/dev/null
unset REG_PASS
REMOTE="$REG_HOST/sr:$SERVICE-$LABEL"
docker tag "$IMAGE" "$REMOTE"
PUSH_LOG=$(docker push "$REMOTE" 2>&1) || { echo "$PUSH_LOG" >&2; die "docker push failed"; }
DIGEST=$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' <<<"$PUSH_LOG" | tail -n 1)
[[ -n $DIGEST ]] || DIGEST=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REMOTE" | sed -n "s|^$REG_HOST/sr@||p" | head -n 1)
[[ -n $DIGEST ]] || { echo "$PUSH_LOG" >&2; die "couldn't read the pushed digest"; }
docker logout "$REG_HOST" >/dev/null 2>&1 || true
IMAGE_REF=$("${AWS[@]}" lightsail register-container-image --service-name "$SERVICE" --label "$LABEL" --digest "$DIGEST" \
  --query containerImage.image --output text)
say "Registered $IMAGE_REF"

# ── 4. the deployment ─────────────────────────────────────────────────────
# The containers spec (with the key, if any) is built by jq from stdin and handed to the CLI
# on stdin. Only the new version number is selected from the response.
say "Deploying"
VERSION=$(printf '%s' "$KEY" | jq -Rs \
  --arg image "$IMAGE_REF" --arg budget "$TOKEN_BUDGET" --arg limit "$TOKEN_LIMIT" \
  --arg rpm "$SANDBOX_RPM" --arg daily "$SANDBOX_DAILY" --arg visitors "$SANDBOX_MAX_VISITORS" \
  --arg tz "$AUREN_TZ" --arg proxy "$TRUST_PROXY" '
  { sandbox: {
      image: $image,
      ports: { "8080": "HTTP" },
      environment: ({
        AUREN_SANDBOX: "true", HOST: "0.0.0.0", PORT: "8080", NODE_ENV: "production",
        AUREN_TRUST_PROXY: $proxy,
        AUREN_SANDBOX_TOKEN_BUDGET: $budget, AUREN_TOKEN_LIMIT: $limit,
        AUREN_SANDBOX_RPM: $rpm, AUREN_SANDBOX_DAILY: $daily, AUREN_SANDBOX_MAX_VISITORS: $visitors,
        AUREN_TZ: $tz
      } + (if . == "" then {} else { MODEL_API_KEY: . } end))
  } }' | "${AWS[@]}" lightsail create-container-service-deployment --service-name "$SERVICE" \
  --containers file:///dev/stdin \
  --public-endpoint '{"containerName":"sandbox","containerPort":8080,"healthCheck":{"path":"/health","intervalSeconds":10,"timeoutSeconds":5,"healthyThreshold":2,"unhealthyThreshold":3,"successCodes":"200"}}' \
  --query containerService.nextDeployment.version --output text)
unset KEY

for i in $(seq 1 90); do
  STATE=$("${AWS[@]}" lightsail get-container-service-deployments --service-name "$SERVICE" \
    --query "deployments[?version==\`$VERSION\`].state | [0]" --output text)
  case $STATE in
    ACTIVE) break ;;
    FAILED) die "deployment $VERSION failed. Logs: aws lightsail get-container-log --region $REGION --service-name $SERVICE --container-name sandbox" ;;
    *) printf '    deployment %s %s...\r' "$VERSION" "$STATE"; sleep 10 ;;
  esac
done
[[ $STATE == ACTIVE ]] || die "deployment $VERSION still $STATE after 15 minutes"

URL=$(service_field url)
say "Live: ${URL}try"
curl -fsS "${URL}health" && echo
cat <<EOF

  Give judges:  ${URL}try
  Status:       deploy/aws/status.sh
  Tear down:    deploy/aws/teardown.sh      (stops all charges)
  Budget alarm: BUDGET_EMAIL=you@example.com deploy/aws/budget.sh
EOF
