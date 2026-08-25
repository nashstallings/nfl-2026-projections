#!/usr/bin/env bash
# One-time Google Cloud setup. Everything a deploy assumes already exists.
#
# Run once, from anywhere gcloud is authenticated — Cloud Shell is easiest.
# Safe to re-run: every step is skipped if it is already done.
#
#   ./infra/bootstrap.sh
#
# Creates the BigQuery dataset and table, the service account Cloud Run runs
# as, and that account's permission to write to the dataset. Deploying — by
# script or from GitHub Actions — assumes all of it is in place.

set -euo pipefail

PROJECT="${PROJECT:-ff-python-api}"
DATASET="${BQ_DATASET:-projections}"
TABLE="${BQ_TABLE:-player_projections}"
LOCATION="${BQ_LOCATION:-US}"
RUNTIME_SA="${RUNTIME_SA:-nfl-projections-run}"

SCHEMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bigquery/schemas"
SA_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"

echo "project ${PROJECT} · dataset ${DATASET} · table ${TABLE} · ${LOCATION}"

# artifactregistry is needed because `gcloud run deploy --source` builds an
# image and pushes it there; without it the first deploy fails during the build
# rather than at validation, which is a much longer way round to the same news.
gcloud services enable \
  bigquery.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project="${PROJECT}" --quiet

# -- BigQuery ---------------------------------------------------------------

if bq --project_id="${PROJECT}" show --dataset "${PROJECT}:${DATASET}" >/dev/null 2>&1; then
  echo "  dataset exists"
else
  # US multi-region to match the nflreadpy dataset. BigQuery cannot join across
  # locations, so a projections table in another region would be permanently
  # unjoinable to the stats it was built from.
  bq --project_id="${PROJECT}" mk \
    --dataset --location="${LOCATION}" \
    --description="Fantasy projections written from the projections dashboard" \
    "${PROJECT}:${DATASET}"
  echo "  dataset created"
fi

if bq --project_id="${PROJECT}" show "${PROJECT}:${DATASET}.${TABLE}" >/dev/null 2>&1; then
  echo "  table exists"
else
  # Partitioned by save date and clustered the way it gets read: pull one
  # player's history, or one team's board, without scanning every save.
  bq --project_id="${PROJECT}" mk \
    --table \
    --time_partitioning_field=saved_at \
    --time_partitioning_type=DAY \
    --clustering_fields=projection_season,team,position,player_id \
    --description="One row per projected player per save. Append-only." \
    "${PROJECT}:${DATASET}.${TABLE}" \
    "${SCHEMA_DIR}/player_projections.json"
  echo "  table created"
fi

# -- the account Cloud Run runs as ------------------------------------------
#
# This lives here rather than in deploy.sh because both deploy paths need it,
# and only one of them runs deploy.sh. A deploy against a service account that
# does not exist fails on actAs, which reads like a permissions problem rather
# than a missing account.

if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "  runtime service account exists"
else
  gcloud iam service-accounts create "${RUNTIME_SA}" \
    --project="${PROJECT}" \
    --display-name="NFL projections dashboard (Cloud Run)"
  echo "  runtime service account created"
fi

# jobUser to run the insert; dataEditor scoped to this one dataset rather than
# the project, because the service has no business reading anything else.
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.jobUser" \
  --condition=None --quiet >/dev/null
echo "  bigquery.jobUser granted"

TMP_POLICY="$(mktemp)"
trap 'rm -f "${TMP_POLICY}"' EXIT
bq --project_id="${PROJECT}" show --format=prettyjson "${PROJECT}:${DATASET}" > "${TMP_POLICY}"
if grep -q "${SA_EMAIL}" "${TMP_POLICY}"; then
  echo "  dataset write access already granted"
else
  python3 - "${TMP_POLICY}" "${SA_EMAIL}" <<'PY'
import json, sys
path, member = sys.argv[1], sys.argv[2]
with open(path) as handle:
    dataset = json.load(handle)
dataset.setdefault("access", []).append({"role": "WRITER", "userByEmail": member})
with open(path, "w") as handle:
    json.dump(dataset, handle)
PY
  bq --project_id="${PROJECT}" update --source "${TMP_POLICY}" "${PROJECT}:${DATASET}"
  echo "  dataset write access granted"
fi

cat <<EOF

Done. ${PROJECT}:${DATASET}.${TABLE} exists, and ${SA_EMAIL}
can write to it.

Next: ./infra/setup-github-oidc.sh to let GitHub Actions deploy, or run
./infra/deploy.sh to deploy from here.
EOF
