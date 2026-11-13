#!/usr/bin/env bash
# Tear down everything after judging.
#   1. Permanently deletes every object version in both buckets (bypassing GOVERNANCE Object Lock).
#   2. Deletes the CloudFormation stack (sam asks for confirmation).
# The KMS key is scheduled for deletion with a 7-day waiting period.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK:-zerohour}"
REGION="${AWS_REGION:-ap-south-1}"

read -r -p "Permanently delete ALL ZeroHour data and the \"$STACK\" stack in $REGION? Type the stack name to confirm: " answer
if [ "$answer" != "$STACK" ]; then
  echo "Aborted."
  exit 1
fi

AWS_REGION="$REGION" npx tsx scripts/empty-buckets.ts --stack "$STACK" --yes
sam delete --stack-name "$STACK" --region "$REGION"
