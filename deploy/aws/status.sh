#!/usr/bin/env bash
# Read-only: the service's state, power, URL, recent deployments and /health.
# Never prints the deployment's environment (it holds MODEL_API_KEY).
set -euo pipefail
source "$(dirname "$0")/common.sh"
need aws curl

service_exists || { echo "No container service '$SERVICE' in $REGION."; exit 0; }
read -r STATE POWER_NOW SCALE_NOW URL <<<"$(service_field '[state,power,scale,url]')"
echo "service      $SERVICE ($REGION): $STATE, $POWER_NOW x $SCALE_NOW"
echo "url          ${URL}try"
echo "deployments:"
"${AWS[@]}" lightsail get-container-service-deployments --service-name "$SERVICE" \
  --query 'deployments[:5].[version,state,containers.sandbox.image,createdAt]' --output text | sed 's/^/  /'
printf 'health       '
curl -fsS --max-time 10 "${URL}health" && echo || echo "unreachable"
echo "logs:        aws lightsail get-container-log --region $REGION --service-name $SERVICE --container-name sandbox"
