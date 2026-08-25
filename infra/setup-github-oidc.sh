#!/usr/bin/env bash
# Let GitHub Actions deploy without storing a service account key.
#
# Creates a Workload Identity pool and provider pinned to this repository, plus
# a deployer service account Actions may impersonate. Run once, from Cloud Shell.

set -euo pipefail

PROJECT="${PROJECT:-ff-python-api}"
REPO="${REPO:-nashstallings/nfl-2026-projections}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github-actions}"
DEPLOYER="${DEPLOYER:-nfl-projections-deployer}"

OWNER="${REPO%%/*}"
SA_EMAIL="${DEPLOYER}@${PROJECT}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"

echo "project ${PROJECT} · repo ${REPO}"

gcloud services enable \
  iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com --project="${PROJECT}" --quiet

if ! gcloud iam workload-identity-pools describe "${POOL}" \
  --project="${PROJECT}" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL}" \
    --project="${PROJECT}" --location=global --display-name="GitHub Actions"
fi

if ! gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
  --project="${PROJECT}" --location=global --workload-identity-pool="${POOL}" >/dev/null 2>&1; then
  # The attribute condition pins the provider to this owner. Without it, any
  # GitHub repository anywhere could present a token to this pool.
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --project="${PROJECT}" --location=global \
    --workload-identity-pool="${POOL}" \
    --display-name="GitHub Actions" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == '${OWNER}'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi

if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOYER}" \
    --project="${PROJECT}" --display-name="NFL projections deployer (GitHub Actions)"
fi

for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/storage.admin \
            roles/artifactregistry.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role="${ROLE}" \
    --condition=None --quiet >/dev/null
done

# Narrowed to this one repository: another repo under the same owner, which the
# provider condition would admit, still cannot impersonate the deployer.
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null

cat <<EOF

Done. Add these under Settings → Secrets and variables → Actions → Variables:

  GCP_WORKLOAD_IDENTITY_PROVIDER
    projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}

  GCP_DEPLOY_SERVICE_ACCOUNT
    ${SA_EMAIL}

  GOOGLE_CLIENT_ID    your OAuth client id
  ALLOWED_EMAILS      who may save, comma separated

The deploy workflow stays inert until the first two exist.
EOF
