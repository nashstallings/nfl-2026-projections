# 2026 Projections

A workbench for projecting NFL fantasy production from **team volume** rather
than from last season's fantasy points.

Points are an outcome. A team throws the ball some number of times, hands it off
some number of times, and those numbers get divided among whoever is on the
roster — so the way to project a player is to project the offense, decide his
share of it, and let the arithmetic produce the points. That is what this does.

```
2025 team volume  ─┐
                   ├──►  what's vacated  ──►  allocate to the 2026 roster  ──►  projected points
2026 roster       ─┘
```

## Where it runs

Deployed to Cloud Run, opened at a URL. Nothing runs on your machine.

The page itself is public — it is public NFL data and arithmetic, and there is
nothing in it worth gating. **Saving** is what needs an identity: the page asks
you to sign in with Google, and the server refuses any account not on its allow
list. Everything except saving works signed out.

### Deploy it

Three one-time steps, all from [Cloud Shell](https://shell.cloud.google.com):

```bash
./infra/bootstrap.sh              # BigQuery dataset and table
./infra/setup-github-oidc.sh      # let Actions deploy without storing a key
```

Then create an OAuth client (**Web application**) at
[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials),
and add the four values it prints — plus your client id and address — under
**Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | printed by `setup-github-oidc.sh` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | printed by `setup-github-oidc.sh` |
| `GOOGLE_CLIENT_ID` | `xxx.apps.googleusercontent.com` |
| `ALLOWED_EMAILS` | who may save, comma separated |

Push to `main` and it deploys. The workflow stays inert until the first two
variables exist, so pushes will not fail before setup. `infra/deploy.sh` does
the same thing by hand if you would rather not wait for Actions.

[`docs/DEPLOYING.md`](docs/DEPLOYING.md) walks through all of it step by step,
including the two things most likely to go wrong.

**Add the Cloud Run URL to the OAuth client's Authorised JavaScript origins**,
or Google refuses the sign-in before it ever reaches the service.

Cloud Run scales to zero between drafts, so this costs essentially nothing.

### Or run it locally anyway

```bash
pip install -r requirements.txt
pip install -e .                 # the package lives in src/, so it needs installing
python -m projections.server     # http://127.0.0.1:8000
```

With no `GOOGLE_CLIENT_ID` set there is no sign-in and writes are open, because
the server binds to loopback and the only caller is you. `data/baseline.json` is
committed, so a first run has nothing to fetch.

To rebuild the baseline against newer rosters:

```bash
python -m projections.build_baseline
```

No credentials needed for that — it reads nflverse's public releases.

## Using it

**Team tab.** Pick a team — every one of the 32 opens on its 2025 season, so
there is somewhere to start rather than a blank sheet. A tick beside a team in
the dropdown means you have changed something there.

The three boxes at the top are its 2026 volume — pass attempts, carries,
targets — starting at last season's totals, with the amount **vacated** noted
underneath and the league's min, median and max on a scale below, so you can see
whether a number is high before you commit to it.

Below that is the roster, and it is a spreadsheet: you type the raw counts. Pass
attempts, passing yards, touchdowns, interceptions, carries, rushing yards,
targets, receptions, receiving yards, fumbles — seeded with what each returning
player actually did on this team in 2025. Newcomers and rookies start empty,
because nothing about their usage is known yet and that is a decision rather
than a default.

**2026 and +/− sit fourth and fifth from the left**, beside the name, and stay
frozen there when the table scrolls sideways. They are the answer: what this
projection scores him, and how that compares to last season. Typing a number
moves both immediately.

**Y/A, Y/C, Y/T and catch rate** are calculated from what you typed and printed
under the box that produces them — yards per target under receiving yards, catch
rate under receptions. They tell you whether the line you just wrote is
plausible: 1,400 yards on 150 targets is 9.33 a target, which is a good season;
on 100 targets it is 14.0, which is nobody's season.

Columns a position never uses are left blank rather than dashed, and the
**Passing / Rushing / Receiving** bands above the headers say which is which.

The **Allocated** row sits directly under the headers, where the budget stays in
view while you spend it. Attempts, carries and targets carry the volume they
have to come out of in the cell — `487` with `161 left` beneath it — amber when
there is volume nobody has been given, red when you have handed out more than
the offence is going to run. Neither gets corrected for you; the correction is
the projection.

Most of a roster will not touch the ball. Players with no projected volume and
no 2025 season are collapsed behind a **Show N more** row at the bottom, so the
ten that decide a team are not diluted by the twelve that do not.

**Click a name** for his last four seasons, which opens beside the table rather
than over it — it is reference for the number you are about to type, so it stays
readable while you type it. Clicking the same name again closes it, as does
Escape.

**Board tab.** All 32 teams, ranked against each other by position, from the
moment you open it. Teams you have tuned carry a tick; the rest are running on
their 2025 baseline, which is the thing you tune away from. Switch **Teams** to
*Only ones I've tuned* to see just your own work. QB1 through QB12 is a
decision; 285 points on its own is not.

## Saving

Two tiers, and they do different jobs:

- **The browser** holds everything, continuously. Close the tab mid-thought and
  nothing is lost. Nothing to press, and no sign-in needed.
- **BigQuery** holds the snapshots you choose to keep. Sign in, press **Save to
  BigQuery**, and it appends one row per projected player under a new save id.
  Saves are never overwritten, so the table accumulates what you believed and
  when — which is the part that gets interesting once the season starts.

**Load** reopens any of them. Each row stores the inputs — the team volume and
each player's shares and games — beside what they produced, so a save is enough
to put you back where you were. Loading replaces what is in the browser, so it
is a restore rather than a merge.

**Export** writes the whole projection to a JSON file, which works signed out
and is the way to hand a projection to something else.

### Why there is a server at all

The dashboard is a static page and could have been published to GitHub Pages.
It isn't, for one reason: **a browser cannot write to BigQuery.** Doing so needs
Google credentials, and a credential shipped to a browser is a credential you
have published.

So the browser never holds one. It holds a Google **ID token** — a short-lived,
signed statement of who you are, minted for this app and useless anywhere else.
Cloud Run verifies it against Google's keys, checks the address against
`ALLOWED_EMAILS`, and only then writes to BigQuery using the service account's
own credentials. Nothing secret reaches the page.

`GOOGLE_CLIENT_ID` *is* served to the page, and that is fine — a client id names
the app to Google and grants nothing on its own.

Two failure modes are refused rather than assumed safe: `deploy.sh` will not
deploy without both `GOOGLE_CLIENT_ID` and `ALLOWED_EMAILS`, and sign-in with an
empty allow list permits nobody rather than everybody.

## The model

A player's line is what you typed. Points come straight off it:

| | |
| --- | --- |
| Passing | 0.04 a yard, 4 a touchdown, −2 an interception |
| Rushing / receiving | 0.1 a yard, 6 a touchdown |
| Fumbles lost | −2 |
| Receptions | 0 / 0.5 / 1 depending on the format |

Every rate on the page — yards per attempt, per carry, per target, catch rate,
touchdown rates — is that line divided, never multiplied back. A rate with no
volume under it shows a dash rather than a zero, because a back with no targets
does not have a bad catch rate; he has none.

Returning players seed from their own 2025 line on this team, so the gap between
what the roster adds up to and the team volume above is exactly the vacated
volume, sitting there waiting to be handed out.

Kickers are excluded, from the data as well as the model. They score from field
goals rather than a share of anyone's attempts, so there is nothing for this to
project — and 43 roster spots that render nowhere are weight in a file every
visitor downloads. `FANTASY_POSITIONS` in `build_baseline.py` brings them back.

Scoring is standard (0.04/passing yard, 4 per passing TD, −2 per interception,
0.1/rushing and receiving yard, 6 per TD, −2 per fumble lost), with half and
full PPR derived from it. All three are shown; pick yours in the header.

### Two things this gets right that a spreadsheet usually doesn't

**Vacated means gone, not traded.** A player who retired or went unsigned
vacated his volume just as completely as one who signed elsewhere. Counting only
the players who changed teams makes an offense that lost 40% of its production
read as stable — Washington's 2025 production is 14% vacated if you count only
departures to other teams, and 42% if you count everyone who is no longer on the
roster.

**Volume belongs to the team that ran the play.** Production is attributed week
by week, so a back traded at the deadline leaves his carries on the roster he
left and brings none of them to the one he joined. Attributing a full season to
whichever team a player finished on misstates both.

## Layout

| Path | What's in it |
| --- | --- |
| `src/projections/build_baseline.py` | Fetches nflverse, writes `data/baseline.json`. |
| `src/projections/check_baseline.py` | Refuses a rebuild that looks half-published. |
| `src/projections/roster_diff.py` | Turns two baselines into "who moved where". |
| `src/projections/server.py` | Serves the page; writes saves to BigQuery. |
| `src/projections/auth.py` | Verifies Google sign-in against the allow list. |
| `src/projections/bigquery_store.py` | Row shape and queries for saved projections. |
| `web/js/projection.js` | The model. Pure functions, no DOM, no globals. |
| `web/js/app.js` | The dashboard. |
| `web/js/auth.js` | Google sign-in in the page. |
| `tests/` | 64 model tests (node), 70 server, auth, and data tests (pytest). |
| `infra/bootstrap.sh` | Creates the BigQuery dataset and table. |
| `infra/deploy.sh` | Deploys to Cloud Run by hand. |
| `infra/setup-github-oidc.sh` | Lets Actions deploy without a stored key. |
| `.github/workflows/refresh.yml` | Daily nflverse poll; rebuilds and redeploys on a change. |

## Checks

```bash
pip install -r requirements-dev.txt
ruff check .
node --test 'tests/**/*.test.js'   # the projection model
pytest -q                          # the server and the row shape
```

## Data

[nflverse](https://github.com/nflverse/nflverse-data) — 2025 weekly player
stats, 2026 rosters, and schedules, pulled from its public GitHub releases and
cached in `.cache/`. Delete that directory to refresh. `data/baseline.json` is
committed so the dashboard runs without rebuilding it.

Rosters move, and a stale baseline describes a roster that no longer exists.
`.github/workflows/refresh.yml` handles that: every morning at 12:00 UTC it
rebuilds against nflverse, and if anything actually moved it commits the new
baseline and redeploys. The commit message says who moved where, so the history
reads as a transaction log rather than a wall of minified JSON. Nothing is
committed when the data is unchanged.

Two things guard the unattended path. `check_baseline.py` refuses a rebuild
that is missing teams or has shed a tenth of the league, which is the shape a
truncated upstream file takes. And the deploy is invoked with `workflow_call`
rather than left to the push trigger, because a push made with `GITHUB_TOKEN`
deliberately does not start another workflow.

You can also run it yourself — Actions -> Refresh baseline -> Run workflow —
or rebuild locally with `python -m projections.build_baseline`.
