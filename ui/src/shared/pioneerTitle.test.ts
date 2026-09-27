import { describe, expect, it } from "vitest";

import { splitPioneerTitle } from "./pioneerTitle";

describe("splitPioneerTitle", () => {
  it("takes the mark out of a marked title", () => {
    expect(splitPioneerTitle("Friday 4v4 [pioneer]")).toEqual({ title: "Friday 4v4", pioneer: true });
  });

  it("reads the mark in any case and anywhere", () => {
    expect(splitPioneerTitle("Friday [PIONEER] 4v4")).toEqual({ title: "Friday 4v4", pioneer: true });
  });

  it("leaves an unmarked title alone", () => {
    expect(splitPioneerTitle("pioneer rush")).toEqual({ title: "pioneer rush", pioneer: false });
  });

  it("gives an empty title back for a mark on its own", () => {
    expect(splitPioneerTitle("[pioneer]")).toEqual({ title: "", pioneer: true });
  });
});
