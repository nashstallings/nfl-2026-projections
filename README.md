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

**Team tab.** Pick a team. The three boxes at the top are its 2026 volume —
pass attempts, carries, targets — starting at last season's totals, with the
amount **vacated** noted underneath. Change them first: if you think an offense
throws 60 more times this year, say so there, and every player's projection
moves with it.

Below that is the roster. Each player gets three share boxes — his cut of
attempts, carries, and targets. Returning players start at the share they
actually earned on this team last season. Newcomers and rookies start at zero,
because nothing about their usage is known yet, and that is a decision rather
than a default.

The footer tracks how much of each category you have handed out. Under 100%
means volume nobody owns; over 100% means you gave the same carry to two backs.
Neither gets corrected for you — the correction is the projection.

**Board tab.** Every team you have projected, ranked against each other by
position. QB1 through QB12 is a decision; 285 points on its own is not.

Rows in grey are running on a **league-median rate** rather than the player's
own, for a rate his own volume actually reaches — the model saying it is
guessing about something that matters. A receiver has no passing rates and
never will, but he is never given a pass attempt either, so that gap does not
grey his row. Rookies given volume are always grey; so are backups asked to do
something they have no history of.

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

Every projected stat is volume times a rate:

| | Volume | Rate |
| --- | --- | --- |
| Passing | team pass attempts × share | yards/attempt, TD%, INT%, completion% |
| Rushing | team carries × share | yards/carry, TD/carry |
| Receiving | team targets × share | catch rate, yards/target, TD/target |
| Fumbles | carries + receptions | fumbles lost per touch |

Rates resolve in two steps: the rate the player earned last season on real
volume, then the league median at his position. The volume floors for "real
volume" are 100 pass attempts, 50 carries, 30 targets — below those a player's
own rate is noise, and the median is the better estimate.

Both are editable per player. **`+ rates`** beside a name opens that player's
efficiency rates, pre-filled with what the projection is currently using;
change one to override it, clear the box to hand it back to the model. An
overridden rate is outlined in the accent colour.

**`G`** sets games played. It divides the season total into a per-game figure —
it does **not** shrink the volume, because the shares are shares of the *whole
season*. A back you expect to miss five games is expressed by lowering his
share and raising his backup's; `G` then tells you what his per-game rate looks
like over the games he does play. That is the number to compare against a
healthy player's PPG.

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
| `src/projections/server.py` | Serves the page; writes saves to BigQuery. |
| `src/projections/auth.py` | Verifies Google sign-in against the allow list. |
| `src/projections/bigquery_store.py` | Row shape and queries for saved projections. |
| `web/js/projection.js` | The model. Pure functions, no DOM, no globals. |
| `web/js/app.js` | The dashboard. |
| `web/js/auth.js` | Google sign-in in the page. |
| `tests/` | 30 model tests (node), 41 server and auth tests (pytest). |
| `infra/bootstrap.sh` | Creates the BigQuery dataset and table. |
| `infra/deploy.sh` | Deploys to Cloud Run by hand. |
| `infra/setup-github-oidc.sh` | Lets Actions deploy without a stored key. |

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

Rosters move. Rebuild the baseline after cutdowns, and after any trade you care
about, or the vacated numbers are describing a roster that no longer exists.
