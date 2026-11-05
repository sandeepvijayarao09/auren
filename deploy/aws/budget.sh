#!/usr/bin/env bash
# Creates a monthly AWS cost budget that emails you at 50% and 80% of actual spend and
# at 100% of forecast. Budgets without actions are free. Safe to re-run (updates the
# amount and leaves existing notifications alone). teardown.sh deletes it.
#
#   BUDGET_EMAIL=you@example.com deploy/aws/budget.sh           # $15/month
#   BUDGET_EMAIL=you@example.com BUDGET_USD=10 deploy/aws/budget.sh
#
# It covers the whole account, not just Lightsail: the alarm is about the bill.
set -euo pipefail
source "$(dirname "$0")/common.sh"

[[ ${1:-} == -h || ${1:-} == --help ]] && { sed -n '2,10p' "$0"; exit 0; }
need aws jq
BUDGET_USD=${BUDGET_USD:-15}
[[ -n ${BUDGET_EMAIL:-} ]] || die "set BUDGET_EMAIL to the address that should get the alerts"
IDENTITY=$(whoami_aws)
read -r ACCOUNT _ <<<"$IDENTITY"

BUDGET=$(jq -n --arg name "$BUDGET_NAME" --arg usd "$BUDGET_USD" \
  '{BudgetName: $name, BudgetLimit: {Amount: $usd, Unit: "USD"}, TimeUnit: "MONTHLY", BudgetType: "COST"}')

if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$BUDGET_NAME" --query Budget.BudgetName --output text >/dev/null 2>&1; then
  say "Budget $BUDGET_NAME exists; setting it to \$$BUDGET_USD/month"
  aws budgets update-budget --account-id "$ACCOUNT" --new-budget "$BUDGET"
else
  say "Creating budget $BUDGET_NAME (\$$BUDGET_USD/month, alerts to $BUDGET_EMAIL)"
  NOTES=$(jq -n --arg email "$BUDGET_EMAIL" '[
    [ "ACTUAL", 50 ], [ "ACTUAL", 80 ], [ "FORECASTED", 100 ]
  ] | map({
    Notification: {NotificationType: .[0], ComparisonOperator: "GREATER_THAN", Threshold: .[1], ThresholdType: "PERCENTAGE"},
    Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]
  })')
  aws budgets create-budget --account-id "$ACCOUNT" --budget "$BUDGET" --notifications-with-subscribers "$NOTES"
fi
say "Done. AWS emails $BUDGET_EMAIL when spend crosses 50% / 80% of \$$BUDGET_USD, or is forecast to pass it."
