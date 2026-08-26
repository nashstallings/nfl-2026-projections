"""Tests for the roster summary.

The summary exists so a scheduled commit says what moved. Its job is to name the
changes that alter a projection and stay quiet about the ones that do not — a
roster churns constantly at the bottom, and a message listing forty practice
squad moves is as useless as one saying "rosters changed".
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from projections.roster_diff import describe, summarize  # noqa: E402


def baseline(*teams):
    return {"teams": {code: {"roster": roster} for code, roster in teams}}


def player(pid, name, position="WR", ppr=100.0):
    return {
        "player_id": pid,
        "player": name,
        "position": position,
        "baseline": {"fantasy_points_ppr": ppr},
    }


class TestDescribe:
    def test_a_trade_names_both_teams(self):
        before = baseline(("NE", [player("1", "Kayshon Boutte")]), ("HOU", []))
        after = baseline(("NE", []), ("HOU", [player("1", "Kayshon Boutte")]))
        (line,) = describe(before, after)
        assert "Kayshon Boutte" in line
        assert "NE -> HOU" in line

    def test_nothing_moving_produces_nothing(self):
        same = baseline(("NE", [player("1", "Stayer")]))
        assert describe(same, same) == []
        assert "no player moved" in summarize(same, same)

    def test_a_signing_with_production_is_named(self):
        before = baseline(("HOU", []))
        after = baseline(("HOU", [player("1", "Signed Veteran", ppr=140.0)]))
        (line,) = describe(before, after)
        assert "joined HOU" in line

    def test_a_departure_with_production_is_named(self):
        before = baseline(("NE", [player("1", "Cut Veteran", ppr=140.0)]))
        after = baseline(("NE", []))
        (line,) = describe(before, after)
        assert "left NE" in line

    def test_churn_by_players_with_no_production_is_counted_not_listed(self):
        before = baseline(("NE", []))
        after = baseline(
            ("NE", [player(str(i), f"Depth {i}", ppr=0.0) for i in range(40)])
        )
        lines = describe(before, after)
        assert len(lines) == 1
        assert "plus 40 roster moves" in lines[0]

    def test_a_trade_is_reported_however_small_the_player(self):
        """A move between teams changes two teams' vacated volume regardless."""
        before = baseline(("NE", [player("1", "Depth", ppr=0.0)]), ("HOU", []))
        after = baseline(("NE", []), ("HOU", [player("1", "Depth", ppr=0.0)]))
        assert any("NE -> HOU" in line for line in describe(before, after))

    def test_the_biggest_mover_is_listed_first(self):
        before = baseline(
            ("NE", [player("1", "Star", ppr=280.0), player("2", "Role", ppr=60.0)]),
            ("HOU", []),
        )
        after = baseline(
            ("NE", []),
            ("HOU", [player("1", "Star", ppr=280.0), player("2", "Role", ppr=60.0)]),
        )
        lines = describe(before, after)
        assert "Star" in lines[0]

    def test_a_player_with_no_2025_line_does_not_crash_the_summary(self):
        rookie = {"player_id": "r", "player": "Rookie", "position": "RB", "baseline": None}
        before = baseline(("NE", [rookie]), ("HOU", []))
        after = baseline(("NE", []), ("HOU", [rookie]))
        assert "Rookie" in describe(before, after)[0]

    def test_an_empty_baseline_is_handled(self):
        assert describe({}, {}) == []
