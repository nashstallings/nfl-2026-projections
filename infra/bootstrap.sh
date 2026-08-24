#!/usr/bin/env bash
# Create the BigQuery dataset and table the Save button writes to.
#
# Run once, from anywhere gcloud is authenticated — Cloud Shell is easiest.
# Safe to re-run: both steps are skipped if the object already exists.

set -euo pipefail

PROJECT="${PROJECT:-ff-python-api}"
DATASET="${BQ_DATASET:-projections}"
TABLE="${BQ_TABLE:-player_projections}"
LOCATION="${BQ_LOCATION:-US}"

SCHEMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bigquery/schemas"

echo "project ${PROJECT} · dataset ${DATASET} · table ${TABLE} · ${LOCATION}"

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
  # player's history, or one team's board, without scanning every save ever made.
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

cat <<EOF

Done. Point the dashboard at it:

  export GCP_PROJECT=${PROJECT}
  export BQ_DATASET=${DATASET}
  export BQ_TABLE=${TABLE}

If you have not already:

  gcloud auth application-default login
EOF
