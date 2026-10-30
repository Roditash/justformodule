#!/usr/bin/env bash
set -euo pipefail

npx --yes vercel@latest login
npx --yes vercel@latest link

cat <<'INSTRUCTIONS'

Before production deployment, configure these Production variables in
Vercel Project Settings > Environment Variables:
  DATABASE_URL
  JWT_SECRET (at least 32 characters)
  INITIAL_ADMIN_PASSWORD (at least 12 characters; required only if the
  database has no users yet)

Add or update secrets in Vercel, not in this script or a committed file.
INSTRUCTIONS

read -r -p "When the Production variables are configured, type DEPLOY to publish: " confirmation
if [[ "$confirmation" != "DEPLOY" ]]; then
  echo "Deployment cancelled. Re-run npm run deploy:vercel when ready."
  exit 0
fi

npx --yes vercel@latest deploy --prod
