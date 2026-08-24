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

## Run it

```bash
pip install -r requirements.txt
python -m projections.build_baseline     # fetch nflverse, write data/baseline.json
python -m projections.server             # http://127.0.0.1:8000
```

That is the whole setup. The baseline build needs no credentials, the server
binds to loopback, and your work saves to the browser as you type.

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
own, which is the model's way of saying it is guessing. That is always true of
rookies and usually true of backups.

## Saving

Two tiers, and they do different jobs:

- **The browser** holds everything, continuously. Close the tab mid-thought and
  nothing is lost. Nothing to press.
- **BigQuery** holds the snapshots you choose to keep. Press **Save to
  BigQuery** and it appends one row per projected player under a new save id.
  Saves are never overwritten, so the table accumulates what you believed and
  when — which is the part that gets interesting once the season starts.

Set up the table once:

```bash
./infra/bootstrap.sh
gcloud auth application-default login
```

**Export** writes the whole projection to a JSON file, which is the fallback
when BigQuery is unreachable and the way to hand a projection to something else.

### Why there is a server at all

The rest of this is a static page, and it could have been published to GitHub
Pages like any other. It isn't, for one reason: **a browser cannot write to
BigQuery.** Doing so needs Google credentials, and a credential shipped to a
browser is a credential you have published — readable by anyone on a public
page, and off your machine even on a private one.

So the Save button posts to the local server instead, and that process talks to
BigQuery using the credentials your machine already has. Nothing secret is ever
sent to the page.

The same app runs on Cloud Run unchanged if you ever want it hosted — set
`API_TOKEN` and `HOST=0.0.0.0` and it will demand that token on every write.
Deploying it *without* setting `API_TOKEN` publishes a write endpoint to your
BigQuery table, so don't.

## The model

Every projected stat is volume times a rate:

| | Volume | Rate |
| --- | --- | --- |
| Passing | team pass attempts × share | yards/attempt, TD%, INT%, completion% |
| Rushing | team carries × share | yards/carry, TD/carry |
| Receiving | team targets × share | catch rate, yards/target, TD/target |
| Fumbles | carries + receptions | fumbles lost per touch |

Rates resolve in three steps: an override you typed, then the rate the player
earned last season on real volume, then the league median at his position. The
volume floors for "real volume" are 100 pass attempts, 50 carries, 30 targets —
below those a player's own rate is noise, and the median is the better estimate.

Kickers are excluded. They do not score off offensive volume, so the model has
nothing to say about them.

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
| `src/projections/bigquery_store.py` | Row shape and queries for saved projections. |
| `web/js/projection.js` | The model. Pure functions, no DOM, no globals. |
| `web/js/app.js` | The dashboard. |
| `tests/` | 30 model tests (node), 21 server tests (pytest). |
| `infra/bootstrap.sh` | Creates the BigQuery dataset and table. |

## Checks

```bash
ruff check .
node --test 'tests/**/*.test.js'   # the projection model
pytest -q              # the server and the row shape
```

## Data

[nflverse](https://github.com/nflverse/nflverse-data) — 2025 weekly player
stats, 2026 rosters, and schedules, pulled from its public GitHub releases and
cached in `.cache/`. Delete that directory to refresh. `data/baseline.json` is
committed so the dashboard runs without rebuilding it.

Rosters move. Rebuild the baseline after cutdowns, and after any trade you care
about, or the vacated numbers are describing a roster that no longer exists.
