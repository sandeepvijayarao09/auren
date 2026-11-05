#!/usr/bin/env bash
# Deletes everything deploy/aws/deploy.sh and budget.sh created: the Lightsail container
# service (with its registry images and deployments; this stops all charges), the SSM
# parameter holding MODEL_API_KEY, and the AWS Budget. Safe to re-run.
#
#   deploy/aws/teardown.sh          # asks first
#   deploy/aws/teardown.sh --yes
#
# Deleting the SSM copy doesn't revoke the key: rotate it at dev.meta.ai after judging.
set -euo pipefail
source "$(dirname "$0")/common.sh"

YES=false
for arg in "$@"; do
  case $arg in
    -y|--yes) YES=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

need aws
IDENTITY=$(whoami_aws)
read -r ACCOUNT ARN <<<"$IDENTITY"

say "Will delete, in $REGION for account $ACCOUNT:"
echo "  Lightsail container service  $SERVICE $(service_exists && echo "($(service_field state))" || echo "(not found)")"
echo "  SSM parameter                $SSM_PARAM"
echo "  AWS Budget                   $BUDGET_NAME"
if [[ $YES != true ]]; then
  read -r -p "Delete them? [y/N] " ok
  [[ $ok == [yY]* ]] || die "stopped; nothing was deleted"
fi

if service_exists; then
  say "Deleting container service $SERVICE"
  "${AWS[@]}" lightsail delete-container-service --service-name "$SERVICE" >/dev/null
else
  echo "  container service: already gone"
fi

if "${AWS[@]}" ssm delete-parameter --name "$SSM_PARAM" >/dev/null 2>&1; then
  say "Deleted SSM parameter $SSM_PARAM"
else
  echo "  SSM parameter: already gone"
fi

if aws budgets delete-budget --account-id "$ACCOUNT" --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
  say "Deleted budget $BUDGET_NAME"
else
  echo "  budget: already gone (or never created)"
fi

say "Done. Remember to rotate MODEL_API_KEY at dev.meta.ai."
