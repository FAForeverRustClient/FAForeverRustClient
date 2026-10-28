import { describe, expect, it } from "vitest";
import { sortRows, type StatsColumn } from "./PlayerStatistics";

type Row = { login: string; games: number };
const columns: StatsColumn<Row>[] = [
  { label: "Name", sortValue: (row) => row.login, render: (row) => row.login },
  { label: "Games", sortValue: (row) => row.games, render: (row) => String(row.games) },
];
const rows: Row[] = [
  { login: "Bravo", games: 5 },
  { login: "alpha", games: 9 },
  { login: "Charlie", games: 5 },
];

describe("sortRows", () => {
  it("keeps the given order until a column is chosen", () => {
    expect(sortRows(rows, columns, null)).toEqual(rows);
  });

  it("sorts numbers by value and keeps ties in their given order", () => {
    expect(sortRows(rows, columns, { column: 1, descending: true }).map((row) => row.login)).toEqual(["alpha", "Bravo", "Charlie"]);
    expect(sortRows(rows, columns, { column: 1, descending: false }).map((row) => row.login)).toEqual(["Bravo", "Charlie", "alpha"]);
  });

  it("sorts names alphabetically", () => {
    expect(sortRows(rows, columns, { column: 0, descending: false }).map((row) => row.login)).toEqual(["alpha", "Bravo", "Charlie"]);
  });
});
