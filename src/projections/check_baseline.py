"""Refuse a rebuilt baseline that looks half-published.

The scheduled refresh commits and deploys without anyone looking at it, so the
one thing standing between a truncated nflverse file and the live dashboard is
this. It checks the shape that upstream failure actually takes — teams missing,
or rosters that collapse — rather than trying to validate the data itself.

    python -m projections.check_baseline before.json after.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

TEAM_COUNT = 32

# Rosters churn every day; they do not shed a tenth of the league overnight.
# A floor rather than a tight tolerance: this is here to catch a broken file,
# not to have an opinion about cut day.
MIN_ROSTER_RATIO = 0.9


def rostered(baseline: dict[str, Any]) -> int:
    return sum(len(team.get("roster") or []) for team in baseline["teams"].values())


def check(before: dict[str, Any] | None, after: dict[str, Any]) -> list[str]:
    """Every reason to reject `after`, or an empty list if there are none."""
    problems = []
    teams = after.get("teams") or {}
    if len(teams) != TEAM_COUNT:
        problems.append(f"baseline has {len(teams)} teams, expected {TEAM_COUNT}")
    empty = sorted(code for code, team in teams.items() if not team.get("roster"))
    if empty:
        problems.append(f"teams with no roster: {', '.join(empty)}")

    # A first build has nothing to compare against, and that is not a failure.
    if before is not None and teams:
        was, now = rostered(before), rostered(after)
        if now < was * MIN_ROSTER_RATIO:
            problems.append(f"rostered players fell from {was} to {now}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    args = parser.parse_args(argv)

    try:
        before = json.loads(args.before.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        before = None
    after = json.loads(args.after.read_text(encoding="utf-8"))

    problems = check(before, after)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"{len(after['teams'])} teams, {rostered(after)} rostered players")
    return 0


if __name__ == "__main__":
    sys.exit(main())
