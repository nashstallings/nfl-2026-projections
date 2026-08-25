# Deploying

Start to finish, roughly 25 minutes. Everything runs in
[Cloud Shell](https://shell.cloud.google.com) and the Google Cloud console —
nothing on your own machine.

The order matters in one place: **you need a client ID before the first deploy,
and the deployed URL before sign-in works.** So the OAuth client gets created
half-configured, then finished once Cloud Run has told you its address.

---

## 1. Open Cloud Shell and get the code

Open [shell.cloud.google.com](https://shell.cloud.google.com), then:

```bash
git clone https://github.com/nashstallings/nfl-2026-projections
cd nfl-2026-projections
gcloud config set project ff-python-api
```

`gcloud` and `bq` are already installed and authenticated there.

---

## 2. Create the BigQuery table

```bash
./infra/bootstrap.sh
```

Creates four things, all of which a deploy assumes already exist: the
`projections` dataset, the `player_projections` table, the service account
Cloud Run runs as, and that account's permission to write to the dataset. Safe
to re-run — every step is skipped if it is already done.

Skipping this and going straight to a deploy fails with
`Permission 'iam.serviceaccounts.actAs' denied`, which reads like the deployer
is missing a permission when really the runtime account was never created.

Confirm both:

```bash
bq show ff-python-api:projections.player_projections
gcloud iam service-accounts describe \
  nfl-projections-run@ff-python-api.iam.gserviceaccount.com
```

---

## 3. Configure the OAuth consent screen

Only needed once per project, and probably already done for `ff-python-api`.
Check [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent).

If it has never been configured:

1. User type **External**, then **Create**.
2. App name: anything (`NFL Projections`). User support email and developer
   contact email: your own address.
3. Save through the Scopes and Test users steps — no scopes need adding, since
   sign-in only asks for your email address.

**If the app is left in Testing mode, add yourself under Test users.** In
Testing mode Google refuses sign-in for any account not on that list, and the
failure appears as a sign-in error with nothing in the Cloud Run logs — the
request never reaches the service. This is the single most likely thing to go
wrong.

---

## 4. Create the OAuth client

[APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
→ **Create credentials** → **OAuth client ID**.

- Application type: **Web application**
- Name: `NFL Projections dashboard`
- **Authorised JavaScript origins**: leave empty for now — you do not have the
  URL yet. Step 7 comes back to this.
- **Authorised redirect URIs**: leave empty. Google Identity Services returns
  an ID token to the page; there is no redirect in this flow.

Copy the **Client ID** (`…apps.googleusercontent.com`). It is not a secret — it
names the app to Google and grants nothing on its own. The client *secret* is
not used here at all.

---

## 5. Let GitHub Actions deploy

```bash
./infra/setup-github-oidc.sh
```

Creates a Workload Identity pool pinned to your GitHub account and a deployer
service account it may impersonate. No service account key is created or
stored anywhere.

It prints two values. Add them, plus two of your own, at
**[Settings → Secrets and variables → Actions](https://github.com/nashstallings/nfl-2026-projections/settings/variables/actions)
→ Variables** (the *Variables* tab, not Secrets — none of these are secret):

| Name | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | printed by the script |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | printed by the script |
| `GOOGLE_CLIENT_ID` | from step 4 |
| `ALLOWED_EMAILS` | `nashstallings17@gmail.com` |

`ALLOWED_EMAILS` is who may write to the table. Comma-separated for more than
one.

---

## 6. Deploy

Either push anything to `main`, or trigger it by hand from
**[Actions → Deploy → Run workflow](https://github.com/nashstallings/nfl-2026-projections/actions/workflows/deploy.yml)**.

The workflow is inert until the first two variables exist, so it will have
skipped every push so far. The first build takes 3–5 minutes; later ones are
faster.

The run ends by polling `/api/healthz` and printing the service URL as a
notice. Or ask directly:

```bash
gcloud run services describe nfl-projections \
  --region us-central1 --format='value(status.url)'
```

If you would rather not use Actions, `./infra/deploy.sh` does the same thing
from Cloud Shell — it needs `GOOGLE_CLIENT_ID` and `ALLOWED_EMAILS` in the
environment and refuses to run without them.

---

## 7. Finish the OAuth client

Back in [Credentials](https://console.cloud.google.com/apis/credentials), open
the client from step 4 and add the Cloud Run URL under **Authorised JavaScript
origins**:

```
https://nfl-projections-XXXXXXXX-uc.a.run.app
```

Exactly the origin — `https://`, no trailing slash, no path. Changes can take a
few minutes to take effect.

---

## 8. Check it works

Open the URL. You should see the workbench with a **Sign in with Google**
button in the header.

1. **Signed out**: pick a team, change a share. It recalculates, and the header
   says *Saved locally*. This half needs no identity at all.
2. **Sign in.** Your address appears in the header.
3. **Save to BigQuery.** The banner should report how many players were saved.
4. Confirm the rows landed:

```bash
bq query --use_legacy_sql=false \
  'SELECT save_id, MIN(saved_at) AS saved_at, COUNT(*) AS players
   FROM `ff-python-api.projections.player_projections`
   GROUP BY save_id ORDER BY saved_at DESC LIMIT 5'
```

---

## When something goes wrong

**Sign-in fails, nothing in the Cloud Run logs.** Google refused before the
request reached the service. Either the origin in step 7 does not exactly match
the URL, or the consent screen is in Testing mode and you are not a test user.

**`401 invalid Google token`.** The token reached the service and failed
verification. Usually the client ID in `GOOGLE_CLIENT_ID` is not the one the
page signed in with — check the deployed value:

```bash
gcloud run services describe nfl-projections --region us-central1 \
  --format='value(spec.template.spec.containers[0].env)'
```

**`401 … is not permitted to write to this table`.** Verification passed; the
address is not in `ALLOWED_EMAILS`. The refused address is in the message and
in the Cloud Run logs.

**`401 no ALLOWED_EMAILS configured, so nobody may write`.** Sign-in is on with
an empty allow list. This is deliberate — the alternative would be letting any
Google account on earth write to your table.

**`502` on save.** The service could not reach BigQuery. Almost always the
runtime service account is missing dataset access; re-running `./infra/deploy.sh`
regrants it.

**The page loads but is empty.** `data/baseline.json` did not make it into the
image. It is committed, so this would mean a build problem — check the Cloud
Build log from the deploy run.

---

## Afterwards

**Rebuild the baseline before you draft.** The 2026 rosters are a snapshot from
whenever `data/baseline.json` was last built. After cutdowns, and after any
trade you care about:

```bash
python -m projections.build_baseline
git commit -am "Rebuild baseline" && git push
```

That push redeploys, since `data/**` is in the deploy workflow's paths.

**Costs.** Cloud Run scales to zero, so the service costs nothing between
sessions. BigQuery storage for a few thousand rows is free in practice. The
build minutes are the only real charge, and they are pennies.
