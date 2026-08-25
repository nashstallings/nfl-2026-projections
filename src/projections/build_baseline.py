"""Build the baseline every projection starts from.

A spreadsheet of last season answers "what happened". Projecting 2026 needs the
question turned around: for each team, *who is on the roster now*, what volume
did the offense generate, and how much of that volume no longer has an owner.

So the unit here is the **2026 roster**, not the 2025 one. A receiver who signed
in March appears on his new team carrying last year's numbers from his old one.
A rookie appears with no numbers at all, which is correct — he has none — but he
still has to appear, because you cannot allocate a backfield without him.

Source is nflverse's public releases; standard library only, no credentials.

    python -m projections.build_baseline

Writes ``data/baseline.json``, which the dashboard loads directly.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import urllib.request
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger("baseline")

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

FANTASY_POSITIONS = ("QB", "RB", "WR", "TE", "K", "FB")

# nflverse spells a few clubs differently between its roster and stats releases.
# Left unnormalized, every Cardinal reads as having changed teams.
TEAM_ALIASES = {
    "AZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU",
    "LAR": "LA", "SL": "LA", "STL": "LA", "OAK": "LV", "SD": "LAC",
}

# The volume a projection allocates. Everything else a player does is derived
# from these three by a rate: yards per attempt, catch rate, touchdown rate.
VOLUME_STATS = ("pass_attempts", "carries", "targets")

# Summed per player and per team, and carried into the output so the dashboard
# can derive efficiency without a second pass over the source.
COUNTING_STATS = (
    "completions", "pass_attempts", "passing_yards", "passing_tds", "interceptions",
    "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds",
    "fumbles_lost",
)

# nflverse column names differ from the ones used here, which are chosen to read
# the way a projection reads rather than the way a play-by-play feed does.
SOURCE_COLUMNS = {
    "completions": "completions",
    "pass_attempts": "attempts",
    "passing_yards": "passing_yards",
    "passing_tds": "passing_tds",
    "interceptions": "passing_interceptions",
    "carries": "carries",
    "rushing_yards": "rushing_yards",
    "rushing_tds": "rushing_tds",
    "targets": "targets",
    "receptions": "receptions",
    "receiving_yards": "receiving_yards",
    "receiving_tds": "receiving_tds",
    "fumbles_lost": "fumbles_lost_total",
}

_MISSING = {"", "NA", "NaN", "nan", "None", "NULL"}


def normalize_team(code: str) -> str:
    return TEAM_ALIASES.get(code, code)


def num(row: dict[str, str], key: str) -> float:
    raw = (row.get(key) or "").strip()
    if raw in _MISSING:
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def text(row: dict[str, str], key: str) -> str:
    raw = (row.get(key) or "").strip()
    return "" if raw in _MISSING else raw


def fetch_csv(url: str, cache_dir: Path) -> list[dict[str, str]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / url.rsplit("/", 1)[-1]
    if cached.exists():
        logger.info("cached   %s", cached.name)
        body = cached.read_text(encoding="utf-8")
    else:
        logger.info("fetching %s", url)
        with urllib.request.urlopen(url, timeout=300) as response:
            body = response.read().decode("utf-8")
        cached.write_text(body, encoding="utf-8")
    return list(csv.DictReader(io.StringIO(body)))


# --------------------------------------------------------------------------
# 2025 production
# --------------------------------------------------------------------------


def season_totals(
    weekly: list[dict[str, str]], season_type: str = "REG"
) -> dict[str, dict[str, Any]]:
    """Total each player's season, and record which teams he produced for.

    Team splits are kept rather than collapsed: a back traded at the deadline
    left volume behind on one roster and joined another, and both teams' 2026
    projections depend on knowing how much.
    """
    players: dict[str, dict[str, Any]] = {}
    for row in weekly:
        if text(row, "season_type") != season_type:
            continue
        position = text(row, "position")
        player_id = text(row, "player_id")
        if position not in FANTASY_POSITIONS or not player_id:
            continue

        player = players.get(player_id)
        if player is None:
            player = players[player_id] = {
                "player_id": player_id,
                "player": text(row, "player_display_name") or text(row, "player_name"),
                "position": position,
                "games": 0,
                "fantasy_points_std": 0.0,
                "fantasy_points_ppr": 0.0,
                "by_team": defaultdict(lambda: defaultdict(float)),
                **{stat: 0.0 for stat in COUNTING_STATS},
            }

        team = normalize_team(text(row, "team"))
        player["games"] += 1
        player["fantasy_points_std"] += num(row, "fantasy_points")
        player["fantasy_points_ppr"] += num(row, "fantasy_points_ppr")
        for stat, source in SOURCE_COLUMNS.items():
            value = num(row, source)
            player[stat] += value
            if team:
                player["by_team"][team][stat] += value
        if team:
            player["by_team"][team]["games"] += 1
    return players


def primary_team(player: dict[str, Any]) -> str:
    """The team a player produced most of his volume for."""
    splits = player["by_team"]
    if not splits:
        return ""
    return max(splits, key=lambda team: splits[team]["games"])


def team_totals(players: dict[str, dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Sum every player's per-team split back up to the offense.

    Built from the weekly splits rather than from season lines so that a
    midseason trade lands on the two teams that actually ran the plays.
    """
    totals: defaultdict[str, defaultdict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    for player in players.values():
        for team, split in player["by_team"].items():
            for stat in COUNTING_STATS:
                totals[team][stat] += split[stat]
    return {team: dict(stats) for team, stats in totals.items()}


# --------------------------------------------------------------------------
# league rates
#
# A rookie has no efficiency history and a backup's is built on fifty snaps.
# Both still need a yards-per-carry to project from, so the league's median at
# the position stands in. Medians rather than means, because one 80-yard
# touchdown on four touches drags a mean somewhere useless.
# --------------------------------------------------------------------------

# Below these volumes a player's own rates are noise, and the positional median
# is the better estimate of what he would do with real usage.
RATE_MINIMUMS = {"pass_attempts": 100, "carries": 50, "targets": 30, "touches": 50}

RATE_DEFINITIONS = {
    "completion_rate": ("completions", "pass_attempts"),
    "yards_per_attempt": ("passing_yards", "pass_attempts"),
    "pass_td_rate": ("passing_tds", "pass_attempts"),
    "interception_rate": ("interceptions", "pass_attempts"),
    "yards_per_carry": ("rushing_yards", "carries"),
    "rush_td_rate": ("rushing_tds", "carries"),
    "catch_rate": ("receptions", "targets"),
    "yards_per_target": ("receiving_yards", "targets"),
    "rec_td_rate": ("receiving_tds", "targets"),
    # Fumbles scale with how often the ball is in a player's hands, not with
    # any one of the three volumes, so they get their own denominator.
    "fumble_rate": ("fumbles_lost", "touches"),
}


def player_rates(stats: dict[str, float]) -> dict[str, float]:
    """Every rate a projection needs, for whichever volume the player had."""
    stats = {**stats, "touches": stats.get("carries", 0.0) + stats.get("receptions", 0.0)}
    rates = {}
    for name, (numerator, denominator) in RATE_DEFINITIONS.items():
        volume = stats.get(denominator, 0.0)
        if volume >= RATE_MINIMUMS[denominator]:
            rates[name] = round(stats.get(numerator, 0.0) / volume, 4)
    return rates


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def league_rates(players: dict[str, dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Median rate per position, over players who cleared the volume minimum."""
    collected: defaultdict[str, defaultdict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for player in players.values():
        for name, value in player_rates(player).items():
            collected[player["position"]][name].append(value)
    return {
        position: {name: round(median(values), 4) for name, values in rates.items()}
        for position, rates in collected.items()
    }


# --------------------------------------------------------------------------
# 2026 rosters
# --------------------------------------------------------------------------

# Statuses that mean a player is not going to take snaps this season. Everything
# else — active, practice squad, exempt — stays on the board, because a backup
# who is one injury from the job is exactly who a projection needs to be able
# to name.
INACTIVE_STATUSES = {"RET", "CUT"}


def roster_by_team(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    rosters: defaultdict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        position = text(row, "position")
        player_id = text(row, "gsis_id")
        if position not in FANTASY_POSITIONS or not player_id:
            continue
        if text(row, "status") in INACTIVE_STATUSES:
            continue
        rosters[normalize_team(text(row, "team"))].append(row)
    return dict(rosters)


def age_on(birth_date: str, as_of: date) -> float | None:
    try:
        year, month, day = (int(part) for part in birth_date.split("-")[:3])
        born = date(year, month, day)
    except (ValueError, TypeError):
        return None
    return round((as_of - born).days / 365.25, 1)


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------


def player_entry(
    row: dict[str, str],
    team: str,
    produced: dict[str, dict[str, Any]],
    projection_season: int,
) -> dict[str, Any]:
    """One roster spot: who he is, and what he did last year if anything."""
    player_id = text(row, "gsis_id")
    season = produced.get(player_id)
    entry: dict[str, Any] = {
        "player_id": player_id,
        "player": text(row, "full_name"),
        "position": text(row, "position"),
        "status": text(row, "status"),
        "age": age_on(text(row, "birth_date"), date(projection_season, 9, 1)),
        "years_exp": int(num(row, "years_exp")),
        "is_rookie": text(row, "rookie_year") == str(projection_season)
        or text(row, "entry_year") == str(projection_season),
        "team_2025": "",
        "played_here_2025": False,
        "baseline": None,
    }
    if season is None:
        return entry

    entry["team_2025"] = primary_team(season)
    here = season["by_team"].get(team)
    entry["played_here_2025"] = bool(here)
    # The season line is the whole player; the split is what this offense saw.
    # Both matter: efficiency comes from the full season, share from the split.
    entry["baseline"] = {
        "games": season["games"],
        "fantasy_points_std": round(season["fantasy_points_std"], 1),
        "fantasy_points_ppr": round(season["fantasy_points_ppr"], 1),
        **{stat: round(season[stat], 1) for stat in COUNTING_STATS},
    }
    entry["here_2025"] = (
        {stat: round(here[stat], 1) for stat in COUNTING_STATS} if here else None
    )
    # Only the rates this player earned the right to; the dashboard fills the
    # rest from the positional median.
    entry["rates"] = player_rates(season)
    return entry


def vacated_totals(
    team: str,
    players: dict[str, dict[str, Any]],
    returning_ids: set[str],
) -> dict[str, float]:
    """Volume this offense generated in 2025 whose producer is no longer here.

    Counts anyone absent from the 2026 roster — not only players who signed
    elsewhere. A back who retired vacated his carries just as completely as one
    who was traded, and treating retirement as continuity is how an offense that
    lost 40% of its production reads as stable.
    """
    vacated: defaultdict[str, float] = defaultdict(float)
    for player_id, player in players.items():
        if player_id in returning_ids:
            continue
        split = player["by_team"].get(team)
        if not split:
            continue
        for stat in COUNTING_STATS:
            vacated[stat] += split[stat]
    return {stat: round(vacated[stat], 1) for stat in COUNTING_STATS}


def build(
    *, season: int, projection_season: int, cache_dir: Path
) -> dict[str, Any]:
    weekly = fetch_csv(f"{NFLVERSE}/stats_player/stats_player_week_{season}.csv", cache_dir)
    rosters = fetch_csv(f"{NFLVERSE}/rosters/roster_{projection_season}.csv", cache_dir)
    games = fetch_csv(GAMES_URL, cache_dir)

    produced = season_totals(weekly)
    totals = team_totals(produced)
    by_team = roster_by_team(rosters)
    games_played = team_games(games, season)

    teams: dict[str, Any] = {}
    for team in sorted(set(totals) | set(by_team)):
        roster = [
            player_entry(row, team, produced, projection_season)
            for row in by_team.get(team, [])
        ]
        roster.sort(
            key=lambda entry: (entry["baseline"] or {}).get("fantasy_points_ppr", 0.0),
            reverse=True,
        )
        returning = {entry["player_id"] for entry in roster}
        teams[team] = {
            "team": team,
            "games_2025": games_played.get(team, 0),
            "totals_2025": {
                stat: round(value, 1) for stat, value in totals.get(team, {}).items()
            },
            "vacated_2025": vacated_totals(team, produced, returning),
            "roster": roster,
        }

    return {
        "season": season,
        "projection_season": projection_season,
        "generated_at": datetime.now(UTC).isoformat(),
        "volume_stats": list(VOLUME_STATS),
        "counting_stats": list(COUNTING_STATS),
        "rate_minimums": RATE_MINIMUMS,
        "league_rates": league_rates(produced),
        "teams": teams,
    }


def team_games(games: list[dict[str, str]], season: int) -> dict[str, int]:
    played: defaultdict[str, int] = defaultdict(int)
    for row in games:
        if text(row, "season") != str(season) or text(row, "game_type") != "REG":
            continue
        if not text(row, "home_score") or not text(row, "away_score"):
            continue
        played[normalize_team(text(row, "home_team"))] += 1
        played[normalize_team(text(row, "away_team"))] += 1
    return dict(played)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, default=2025)
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--out", type=Path, default=Path("data/baseline.json"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    baseline = build(
        season=args.season,
        projection_season=args.projection_season,
        cache_dir=args.cache_dir,
    )
    rostered = sum(len(team["roster"]) for team in baseline["teams"].values())

    # Rosters change in bursts — a cutdown, a trade — and are static in between.
    # Rewriting an identical file would change only the timestamp, and since a
    # push of data/ redeploys the service, that is a full rebuild bought for
    # nothing. Say so and leave the file alone.
    if args.out.exists() and not _changed(args.out, baseline):
        logger.info(
            "%s is already current — %s roster spots, nothing to rebuild",
            args.out,
            rostered,
        )
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(baseline, separators=(",", ":")), encoding="utf-8")
    logger.info(
        "wrote %s — %s teams, %s roster spots for %s",
        args.out,
        len(baseline["teams"]),
        rostered,
        args.projection_season,
    )
    return 0


def _changed(path: Path, baseline: dict[str, Any]) -> bool:
    """Whether a rebuild differs from what is on disk, ignoring the timestamp.

    A corrupt or unreadable file counts as changed: rewriting it is the repair.
    """
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return {k: v for k, v in existing.items() if k != "generated_at"} != {
        k: v for k, v in baseline.items() if k != "generated_at"
    }


if __name__ == "__main__":
    raise SystemExit(main())
