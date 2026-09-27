import { describe, expect, it } from "vitest";

import { splitGoAdapterTitle } from "./goAdapterTitle";

describe("splitGoAdapterTitle", () => {
  it("takes the mark out of a marked title", () => {
    expect(splitGoAdapterTitle("Friday 4v4 [go-adapter]")).toEqual({ title: "Friday 4v4", goAdapter: true });
  });

  it("reads the mark in any case and anywhere", () => {
    expect(splitGoAdapterTitle("Friday [GO-ADAPTER] 4v4")).toEqual({ title: "Friday 4v4", goAdapter: true });
  });

  it("leaves an unmarked title alone", () => {
    expect(splitGoAdapterTitle("pioneer rush")).toEqual({ title: "pioneer rush", goAdapter: false });
  });

  it("gives an empty title back for a mark on its own", () => {
    expect(splitGoAdapterTitle("[go-adapter]")).toEqual({ title: "", goAdapter: true });
  });
});
