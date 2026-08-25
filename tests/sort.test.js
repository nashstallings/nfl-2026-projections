/**
 * Tests for column sorting.
 *
 * The cases that matter are the ones about absent values and about what a
 * fresh click should do — the parts that make a table pleasant or maddening.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ariaSort, nextDirection, sortRows } from "../web/js/sort.js";

const rows = [
  { player: "Chase", pts: 300 },
  { player: "adams", pts: 100 },
  { player: "Brown", pts: 200 },
];

const names = (sorted) => sorted.map((row) => row.player);

describe("sortRows", () => {
  test("numbers sort by value, descending by default", () => {
    assert.deepEqual(names(sortRows(rows, "pts")), ["Chase", "Brown", "adams"]);
  });

  test("ascending reverses it", () => {
    assert.deepEqual(names(sortRows(rows, "pts", "asc")), ["adams", "Brown", "Chase"]);
  });

  test("text sorts case-insensitively", () => {
    // A naive comparison puts every lowercase name after every uppercase one.
    assert.deepEqual(names(sortRows(rows, "player", "asc")), ["adams", "Brown", "Chase"]);
  });

  test("the input is not mutated", () => {
    const before = names(rows);
    sortRows(rows, "pts", "asc");
    assert.deepEqual(names(rows), before);
  });

  test("rows with no value sort last when descending", () => {
    const withGaps = [...rows, { player: "Unallocated", pts: null }];
    assert.equal(names(sortRows(withGaps, "pts", "desc")).at(-1), "Unallocated");
  });

  test("rows with no value sort last when ascending too", () => {
    // The point: "lowest points" means lowest among the projected.
    const withGaps = [...rows, { player: "Unallocated", pts: null }];
    assert.equal(names(sortRows(withGaps, "pts", "asc")).at(-1), "Unallocated");
  });

  test("undefined and NaN count as missing, not as zero", () => {
    const odd = [
      { player: "A", pts: 5 },
      { player: "B" },
      { player: "C", pts: NaN },
      { player: "D", pts: 0 },
    ];
    const order = names(sortRows(odd, "pts", "asc"));
    assert.deepEqual(order.slice(0, 2), ["D", "A"]);
    assert.deepEqual(order.slice(2).sort(), ["B", "C"]);
  });

  test("zero is a value, not a gap", () => {
    const withZero = [{ player: "Z", pts: 0 }, { player: "N", pts: null }];
    assert.deepEqual(names(sortRows(withZero, "pts", "desc")), ["Z", "N"]);
  });

  test("ties keep their previous order, so sorts compose", () => {
    const tied = [
      { player: "first", pos: "RB", pts: 1 },
      { player: "second", pos: "RB", pts: 2 },
      { player: "third", pos: "WR", pts: 3 },
    ];
    const byPoints = sortRows(tied, "pts", "asc");
    assert.deepEqual(names(sortRows(byPoints, "pos", "asc")), [
      "first", "second", "third",
    ]);
  });

  test("an unknown column leaves the order alone rather than scrambling it", () => {
    assert.deepEqual(names(sortRows(rows, "nonexistent")), names(rows));
  });
});

describe("nextDirection", () => {
  test("a new numeric column opens descending — most first", () => {
    assert.equal(nextDirection(null, "pts"), "desc");
    assert.equal(nextDirection({ key: "player", direction: "asc" }, "pts"), "desc");
  });

  test("a new text column opens ascending — A first", () => {
    assert.equal(nextDirection(null, "player", "text"), "asc");
  });

  test("clicking the sorted column reverses it", () => {
    assert.equal(nextDirection({ key: "pts", direction: "desc" }, "pts"), "asc");
    assert.equal(nextDirection({ key: "pts", direction: "asc" }, "pts"), "desc");
  });
});

describe("ariaSort", () => {
  test("only the sorted column is announced as sorted", () => {
    const current = { key: "pts", direction: "desc" };
    assert.equal(ariaSort(current, "pts"), "descending");
    assert.equal(ariaSort(current, "player"), "none");
    assert.equal(ariaSort({ key: "pts", direction: "asc" }, "pts"), "ascending");
  });
});
