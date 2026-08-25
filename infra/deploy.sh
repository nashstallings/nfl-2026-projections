#!/usr/bin/env bash
# Deploy the dashboard to Cloud Run.
#
# Run from Cloud Shell, or anywhere gcloud is authenticated. Expects
# ./infra/bootstrap.sh to have run first — it checks for what that creates
# rather than creating it, so this path and the GitHub Actions one cannot drift.
#
#   ALLOWED_EMAILS=you@gmail.com GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
#     ./infra/deploy.sh

set -euo pipefail

PROJECT="${PROJECT:-ff-python-api}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-nfl-projections}"
DATASET="${BQ_DATASET:-projections}"
TABLE="${BQ_TABLE:-player_projections}"
RUNTIME_SA="${RUNTIME_SA:-nfl-projections-run}"

# One source of truth for the client id, overridable from the environment.
DEFAULTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.defaults"
if [[ -f "${DEFAULTS}" ]]; then
  # shellcheck source=/dev/null
  source "${DEFAULTS}"
fi

GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"

# Refusing here rather than deploying is deliberate. With sign-in unconfigured
# the service would answer writes from anyone who found the URL, and a public
# write endpoint to your own BigQuery table is not something to discover later.
if [[ -z "${GOOGLE_CLIENT_ID}" || -z "${ALLOWED_EMAILS}" ]]; then
  cat >&2 <<'MSG'
GOOGLE_CLIENT_ID and ALLOWED_EMAILS must both be set.

Without them this service would accept a save from anybody who found its URL.
Create an OAuth client (Web application) at
https://console.cloud.google.com/apis/credentials, then:

  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com \
  ALLOWED_EMAILS=you@gmail.com \
    ./infra/deploy.sh
MSG
  exit 1
fi

SA_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"

echo "project ${PROJECT} · region ${REGION} · service ${SERVICE}"

# Prerequisites belong to bootstrap.sh, so both deploy paths get them. Checking
# rather than creating keeps the two paths honest with each other: if this
# script created what Actions cannot, the two would drift.
MISSING=""
if ! bq --project_id="${PROJECT}" show --dataset "${PROJECT}:${DATASET}" >/dev/null 2>&1; then
  MISSING="the ${DATASET} dataset"
fi
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  MISSING="${MISSING:+${MISSING} and }the ${SA_EMAIL} service account"
fi
if [[ -n "${MISSING}" ]]; then
  echo "missing ${MISSING} — run ./infra/bootstrap.sh first" >&2
  exit 1
fi

# The ^|^ prefix changes the delimiter gcloud splits this list on. The default
# is a comma, which ALLOWED_EMAILS uses to separate addresses — so a second
# address would be read as another variable name and rejected.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --source=. \
  --service-account="${SA_EMAIL}" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --set-env-vars="^|^GCP_PROJECT=${PROJECT}|BQ_DATASET=${DATASET}|BQ_TABLE=${TABLE}|BIGQUERY_ENABLED=true|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}|ALLOWED_EMAILS=${ALLOWED_EMAILS}" \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')"

# A green deploy only means the revision was accepted. This proves it boots.
echo "  waiting for ${URL}/api/healthz"
for _ in $(seq 1 30); do
  if curl -fsS "${URL}/api/healthz" >/dev/null 2>&1; then
    echo "  healthy"
    break
  fi
  sleep 2
done

cat <<EOF

Deployed: ${URL}

--allow-unauthenticated lets the page load for anyone, which is fine — it is
public NFL data and arithmetic. Saving is gated separately, by Google sign-in
against ALLOWED_EMAILS.

Add ${URL} to the OAuth client's Authorised JavaScript origins, or sign-in
will be refused by Google before it ever reaches this service.
EOF
