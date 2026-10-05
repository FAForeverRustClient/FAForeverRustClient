import { describe, expect, it } from "vitest";

import { settledNotice, writeFailure } from "./queueNotices";
import type { GuideSubmission, GuidesState } from "../../ipc/bindings";

const row = (number: number): GuideSubmission => ({
  number,
  title: `Training submission: Guide ${number}`,
  summary: "",
  entry: null,
  author: "",
  authorAvatarUrl: "",
  createdAt: "",
  url: "",
  guide: null,
});

const state = (over: Partial<GuidesState>): GuidesState => ({
  auth: { type: "signedOut" },
  submissions: [],
  status: { type: "ready" },
  write: { type: "idle" },
  submit: { type: "idle" },
  repo: "o/r",
  settled: [],
  ...over,
});

describe("the queue's word on the last verdict", () => {
  it("shows a failure while its row is still listed", () => {
    const failed = state({
      submissions: [row(7)],
      write: { type: "failed", payload: { number: 7, reason: "GitHub said no" } },
    });
    expect(writeFailure(failed)).toEqual({ number: 7, reason: "GitHub said no" });
  });

  it("drops a failure once its row has gone", () => {
    // The error used to stay beside a list that no longer had the row.
    const gone = state({
      submissions: [row(8)],
      write: { type: "failed", payload: { number: 7, reason: "GitHub said no" } },
    });
    expect(writeFailure(gone)).toBeNull();
  });

  it("says a verdict worked after its row has left the list", () => {
    expect(settledNotice(state({ write: { type: "accepted", payload: { number: 3 } } }))).toEqual({
      verdict: "accepted",
      number: 3,
    });
    expect(settledNotice(state({ write: { type: "rejected", payload: { number: 4 } } }))).toEqual({
      verdict: "declined",
      number: 4,
    });
    expect(settledNotice(state({ write: { type: "accepting", payload: { number: 4 } } }))).toBeNull();
    expect(settledNotice(state({}))).toBeNull();
  });
});
