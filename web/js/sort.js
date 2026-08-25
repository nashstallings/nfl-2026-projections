/**
 * Column sorting for the tables.
 *
 * Small, but with two decisions in it that are easy to get wrong and annoying
 * to live with. Both are about rows that have no value in the sorted column —
 * a player with no allocation yet, whose projected points are a dash.
 *
 * They sort last in *both* directions. Ascending by points otherwise opens with
 * a screenful of players you have not touched, burying the ones you have; the
 * question "who is projected lowest" means lowest among the projected.
 *
 * And a click on a new column starts descending for numbers, ascending for
 * text, because that is what each is usually being asked: the most points, or
 * the As first.
 */

/** Compare two values of the same column. Missing values are handled by the caller. */
function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function isMissing(value) {
  return value === null || value === undefined || value === "" || Number.isNaN(value);
}

/**
 * Sort a copy of `rows` by `key`. Never mutates the input.
 *
 * Ties keep their previous order, so sorting by position leaves each position's
 * players in whatever order the last sort put them — a stable sort is what makes
 * two clicks compose into "by position, then by points".
 */
export function sortRows(rows, key, direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    const aMissing = isMissing(a);
    const bMissing = isMissing(b);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1; // always last, whichever way the column is pointing
    if (bMissing) return -1;
    return sign * compare(a, b);
  });
}

/**
 * The direction a click should produce.
 *
 * Clicking the column already sorted reverses it. Clicking a new one starts
 * from the end of that column people usually want.
 */
export function nextDirection(current, key, type = "number") {
  if (current?.key === key) return current.direction === "asc" ? "desc" : "asc";
  return type === "text" ? "asc" : "desc";
}

/** The `aria-sort` value for a header, so the sort is announced, not just drawn. */
export function ariaSort(current, key) {
  if (current?.key !== key) return "none";
  return current.direction === "asc" ? "ascending" : "descending";
}
