"""Tests for the BigQuery row shape.

Nothing here talks to BigQuery. What is worth testing is the translation between
what the browser holds and what a row looks like — the place where a share ends
up in the wrong column, or a save silently writes zero rows.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from projections.bigquery_store import ROW_FIELDS, StoreError, flatten  # noqa: E402


def payload(**overrides):
    base = {
        "projection_season": 2026,
        "label": "post free agency",
        "teams": [
            {
                "team": "MIN",
                "volume": {"pass_attempts": 550, "carries": 420, "targets": 500},
                "players": [
                    {
                        "player_id": "00-0039923",
                        "player": "J.J. McCarthy",
                        "position": "QB",
                        "games": 17,
                        "shares": {"pass": 0.92, "rush": 0.11, "recv": 0},
                        "stats": {
                            "pass_attempts": 506.0, "completions": 330.0,
                            "passing_yards": 3800.0, "passing_tds": 24.0,
                            "interceptions": 11.0, "carries": 46.2,
                            "rushing_yards": 240.0, "rushing_tds": 2.0,
                            "targets": 0.0, "receptions": 0.0,
                            "receiving_yards": 0.0, "receiving_tds": 0.0,
                            "fumbles_lost": 1.5,
                        },
                        "points": {"std": 274.0, "half_ppr": 274.0, "ppr": 274.0},
                    }
                ],
            }
        ],
    }
    base.update(overrides)
    return base


class TestFlatten:
    def test_one_row_per_player(self):
        assert len(flatten(payload())) == 1

    def test_every_declared_field_is_written(self):
        (row,) = flatten(payload())
        assert set(row) == set(ROW_FIELDS)

    def test_inputs_are_stored_beside_outputs(self):
        """A row has to explain itself without the baseline file it came from."""
        (row,) = flatten(payload())
        assert row["share_pass"] == 0.92
        assert row["team_pass_attempts"] == 550
        assert row["pass_attempts"] == 506.0
        assert row["fantasy_points_ppr"] == 274.0

    def test_rows_from_one_save_share_an_id_and_timestamp(self):
        multi = payload()
        multi["teams"].append({**multi["teams"][0], "team": "PHI"})
        rows = flatten(multi)
        assert len({row["save_id"] for row in rows}) == 1
        assert len({row["saved_at"] for row in rows}) == 1
        assert {row["team"] for row in rows} == {"MIN", "PHI"}

    def test_separate_saves_get_separate_ids(self):
        assert flatten(payload())[0]["save_id"] != flatten(payload())[0]["save_id"]

    def test_an_empty_payload_is_refused_rather_than_written(self):
        with pytest.raises(StoreError, match="nothing to save"):
            flatten(payload(teams=[]))

    def test_a_team_with_no_projected_players_writes_nothing(self):
        with pytest.raises(StoreError):
            flatten(payload(teams=[{"team": "MIN", "volume": {}, "players": []}]))

    def test_missing_numbers_become_zero_rather_than_none(self):
        thin = payload()
        thin["teams"][0]["players"][0]["stats"] = {}
        thin["teams"][0]["players"][0]["points"] = {}
        (row,) = flatten(thin)
        assert row["passing_yards"] == 0.0
        assert row["fantasy_points_ppr"] == 0.0

    def test_a_missing_volume_does_not_raise(self):
        thin = payload()
        del thin["teams"][0]["volume"]
        (row,) = flatten(thin)
        assert row["team_carries"] == 0

    def test_an_overlong_label_is_truncated(self):
        (row,) = flatten(payload(label="x" * 500))
        assert len(row["label"]) == 200
