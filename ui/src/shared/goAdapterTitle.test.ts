import { describe, expect, it } from "vitest";

import { splitGoAdapterTitle } from "./goAdapterTitle";

describe("splitGoAdapterTitle", () => {
  it("takes the mark out of a marked title", () => {
    expect(splitGoAdapterTitle("Friday 4v4 [go-adapter]")).toEqual({ title: "Friday 4v4", goAdapter: true, expJavaAdapter: false });
  });

  it("reads the mark in any case and anywhere", () => {
    expect(splitGoAdapterTitle("Friday [GO-ADAPTER] 4v4")).toEqual({ title: "Friday 4v4", goAdapter: true, expJavaAdapter: false });
  });

  it("takes exp-java-adapter mark out of a marked title", () => {
    expect(splitGoAdapterTitle("Friday 4v4 [exp-java-adapter]")).toEqual({ title: "Friday 4v4", goAdapter: false, expJavaAdapter: true });
    expect(splitGoAdapterTitle("Friday [EXP-JAVA-ADAPTER] 4v4")).toEqual({ title: "Friday 4v4", goAdapter: false, expJavaAdapter: true });
  });

  it("leaves an unmarked title alone", () => {
    expect(splitGoAdapterTitle("pioneer rush")).toEqual({ title: "pioneer rush", goAdapter: false, expJavaAdapter: false });
  });

  it("gives an empty title back for a mark on its own", () => {
    expect(splitGoAdapterTitle("[go-adapter]")).toEqual({ title: "", goAdapter: true, expJavaAdapter: false });
    expect(splitGoAdapterTitle("[exp-java-adapter]")).toEqual({ title: "", goAdapter: false, expJavaAdapter: true });
  });
});
