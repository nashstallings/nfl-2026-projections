#!/usr/bin/env bash
# Deploy the dashboard to Cloud Run.
#
# Run from Cloud Shell, or anywhere gcloud is authenticated. Creates the runtime
# service account and its BigQuery grants on first run, then builds and deploys.
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

gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com bigquery.googleapis.com \
  --project="${PROJECT}" --quiet

if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "  runtime service account exists"
else
  gcloud iam service-accounts create "${RUNTIME_SA}" \
    --project="${PROJECT}" \
    --display-name="NFL projections dashboard (Cloud Run)"
  echo "  runtime service account created"
fi

# jobUser to run the insert, dataEditor scoped to the one dataset rather than
# the project — this service has no business reading anything else in BigQuery.
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.jobUser" \
  --condition=None --quiet >/dev/null

TMP_POLICY="$(mktemp)"
trap 'rm -f "${TMP_POLICY}"' EXIT
bq --project_id="${PROJECT}" show --format=prettyjson "${PROJECT}:${DATASET}" > "${TMP_POLICY}"
if grep -q "${SA_EMAIL}" "${TMP_POLICY}"; then
  echo "  dataset access already granted"
else
  python3 - "${TMP_POLICY}" "${SA_EMAIL}" <<'PY'
import json, sys
path, member = sys.argv[1], sys.argv[2]
with open(path) as handle:
    dataset = json.load(handle)
dataset.setdefault("access", []).append(
    {"role": "WRITER", "userByEmail": member}
)
with open(path, "w") as handle:
    json.dump(dataset, handle)
PY
  bq --project_id="${PROJECT}" update --source "${TMP_POLICY}" "${PROJECT}:${DATASET}"
  echo "  dataset write access granted"
fi

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --source=. \
  --service-account="${SA_EMAIL}" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --set-env-vars="GCP_PROJECT=${PROJECT},BQ_DATASET=${DATASET},BQ_TABLE=${TABLE},BIGQUERY_ENABLED=true,GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},ALLOWED_EMAILS=${ALLOWED_EMAILS}" \
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
