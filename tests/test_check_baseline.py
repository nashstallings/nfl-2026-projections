"""The guard between an unattended nflverse rebuild and the live dashboard."""

from __future__ import annotations

import json

import pytest

from projections.check_baseline import check, main


def baseline(counts: dict[str, int] | None = None) -> dict:
    """A well-formed baseline: 32 teams with `counts` roster spots each."""
    counts = counts or {}
    teams = {}
    for index in range(32):
        code = f"T{index:02d}"
        size = counts.get(code, 10)
        teams[code] = {
            "roster": [{"player_id": f"{code}-{n}"} for n in range(size)],
        }
    return {"teams": teams}


def test_healthy_baseline_has_no_problems():
    assert check(baseline(), baseline()) == []


def test_missing_team_is_rejected():
    short = baseline()
    del short["teams"]["T31"]
    assert check(baseline(), short) == ["baseline has 31 teams, expected 32"]


def test_empty_roster_is_named():
    hollow = baseline()
    hollow["teams"]["T07"]["roster"] = []
    assert check(baseline(), hollow) == ["teams with no roster: T07"]


def test_several_empty_rosters_are_all_named():
    hollow = baseline()
    for code in ("T02", "T07"):
        hollow["teams"][code]["roster"] = []
    assert check(baseline(), hollow) == ["teams with no roster: T02, T07"]


def test_collapse_in_rostered_players_is_rejected():
    # 320 -> 256, a fifth of the league gone.
    shrunk = baseline({f"T{i:02d}": 8 for i in range(32)})
    assert check(baseline(), shrunk) == ["rostered players fell from 320 to 256"]


def test_ordinary_churn_passes():
    # Five percent, which is a normal week of cuts, not a broken file.
    trimmed = baseline({f"T{i:02d}": 10 - (i % 2) for i in range(32)})
    assert check(baseline(), trimmed) == []


def test_growth_is_never_a_problem():
    grown = baseline({f"T{i:02d}": 20 for i in range(32)})
    assert check(baseline(), grown) == []


def test_first_build_has_nothing_to_compare_against():
    assert check(None, baseline()) == []


def test_a_missing_before_file_does_not_fail_the_check(tmp_path, capsys):
    after = tmp_path / "after.json"
    after.write_text(json.dumps(baseline()), encoding="utf-8")

    assert main([str(tmp_path / "nope.json"), str(after)]) == 0
    assert "32 teams, 320 rostered players" in capsys.readouterr().out


def test_main_reports_every_problem_before_failing(tmp_path, capsys):
    before = tmp_path / "before.json"
    after = tmp_path / "after.json"
    before.write_text(json.dumps(baseline()), encoding="utf-8")
    broken = baseline({f"T{i:02d}": 1 for i in range(32)})
    broken["teams"]["T03"]["roster"] = []
    after.write_text(json.dumps(broken), encoding="utf-8")

    assert main([str(before), str(after)]) == 1
    err = capsys.readouterr().err
    assert "teams with no roster: T03" in err
    assert "rostered players fell from 320 to 31" in err


def test_unreadable_after_file_is_not_swallowed(tmp_path):
    after = tmp_path / "after.json"
    after.write_text("{ truncated", encoding="utf-8")
    # A half-written file is exactly the failure this guards; it must raise
    # rather than quietly pass the way a missing `before` does.
    with pytest.raises(ValueError):
        main([str(tmp_path / "nope.json"), str(after)])
