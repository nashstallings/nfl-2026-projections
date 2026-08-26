"""Say what moved between two baselines.

A rebuilt baseline is half a megabyte of minified JSON; its diff tells you
nothing. This turns two of them into the sentence you actually wanted — who
joined, who left, who changed teams — which is what a scheduled rebuild should
put in its commit message.

    python -m projections.roster_diff before.json after.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Movement is only interesting for players who did something. A practice-squad
# receiver with no 2025 snaps changing teams is noise; the ones carrying volume
# are the ones that change what a team has to hand out.
NOTABLE_PPR = 20.0


def index(baseline: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every rostered player, by id, with the team he is on."""
    players = {}
    for code, team in (baseline.get("teams") or {}).items():
        for entry in team.get("roster") or []:
            players[entry["player_id"]] = {
                "team": code,
                "player": entry.get("player", ""),
                "position": entry.get("position", ""),
                "ppr": (entry.get("baseline") or {}).get("fantasy_points_ppr", 0.0),
            }
    return players


def describe(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """One line per change, most consequential first."""
    old, new = index(before), index(after)

    moved = [
        (new[pid], old[pid]["team"])
        for pid in old.keys() & new.keys()
        if old[pid]["team"] != new[pid]["team"]
    ]
    joined = [new[pid] for pid in new.keys() - old.keys()]
    left = [old[pid] for pid in old.keys() - new.keys()]

    lines: list[str] = []
    for entry, was in sorted(moved, key=lambda item: -item[0]["ppr"]):
        lines.append(
            f"  {entry['position']} {entry['player']}: {was} -> {entry['team']}"
            f" ({entry['ppr']:.0f} PPR in 2025)"
        )

    # Signings and departures are listed only when they carry real production;
    # a roster churns constantly at the bottom and none of it moves a projection.
    for entry in sorted(joined, key=lambda item: -item["ppr"]):
        if entry["ppr"] >= NOTABLE_PPR:
            lines.append(
                f"  {entry['position']} {entry['player']}: joined {entry['team']}"
                f" ({entry['ppr']:.0f} PPR in 2025)"
            )
    for entry in sorted(left, key=lambda item: -item["ppr"]):
        if entry["ppr"] >= NOTABLE_PPR:
            lines.append(
                f"  {entry['position']} {entry['player']}: left {entry['team']}"
                f" ({entry['ppr']:.0f} PPR in 2025)"
            )

    quiet = len(joined) + len(left) - sum(
        1 for entry in joined + left if entry["ppr"] >= NOTABLE_PPR
    )
    if quiet:
        lines.append(f"  plus {quiet} roster moves by players with no 2025 production")
    return lines


def summarize(before: dict[str, Any], after: dict[str, Any]) -> str:
    lines = describe(before, after)
    if not lines:
        return "Rosters changed, but no player moved between teams."
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    args = parser.parse_args(argv)

    try:
        before = json.loads(args.before.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # No previous baseline to compare against — the rebuild is the summary.
        print("First build of this baseline; nothing to compare against.")
        return 0

    after = json.loads(args.after.read_text(encoding="utf-8"))
    print(summarize(before, after))
    return 0


if __name__ == "__main__":
    sys.exit(main())
