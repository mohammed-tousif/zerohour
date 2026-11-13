#!/usr/bin/env bash
# Build and deploy the ZeroHour stack to ap-south-1 (Mumbai).
#   ./scripts/deploy.sh             (or: npm run deploy)
# Extra arguments go to `sam deploy`, e.g. --guided.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK:-zerohour}"
REGION="${AWS_REGION:-ap-south-1}"

npm run typecheck
npm test

# We bundle the Lambdas ourselves (esbuild → dist/lambda/*). SAM only zips those
# folders, so it never runs npm here. (SAM's in-source esbuild build runs an npm
# update that strips devDependencies from this repo.)
npm run bundle
sam build

sam deploy \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  "$@"
