import { describe, expect, it } from "vitest";
import type { ReviewRequestDraft } from "../../ipc/bindings";
import {
  forgetReview,
  keepReview,
  keptReview,
  replayReference,
  reviewKey,
  sameReview,
  withReplay,
} from "./reviewDraft";

const draft = (changes: Partial<ReviewRequestDraft> = {}): ReviewRequestDraft => ({
  replayId: null,
  replayLink: "",
  replayFile: "",
  player: "Tim",
  rating: "1150",
  gameMode: "1v1",
  map: "Setons Clutch",
  faction: "Aeon",
  playedAt: "",
  goal: "",
  struggle: "",
  ...changes,
});

describe("the replay field", () => {
  it("shows the reference the post will name, id included", () => {
    expect(replayReference(draft({ replayLink: "https://replay.faforever.com/1", replayId: 1 }))).toBe(
      "https://replay.faforever.com/1",
    );
    expect(replayReference(draft({ replayId: 42, replayFile: "local.fafreplay" }))).toBe("#42");
    expect(replayReference(draft({ replayFile: "local.fafreplay" }))).toBe("local.fafreplay");
  });

  it("can be cleared without the local file coming back", () => {
    const opened = draft({ replayFile: "local.fafreplay" });
    const cleared = withReplay(opened, "");
    expect(replayReference(cleared)).toBe("");
    expect(cleared.replayFile).toBe("");
  });

  it("names one replay after typing, not the typed one and the opened one", () => {
    const typed = withReplay(draft({ replayId: 7, replayFile: "a.fafreplay" }), "https://x.example/9");
    expect(typed).toMatchObject({ replayLink: "https://x.example/9", replayId: null, replayFile: "" });
  });
});

describe("keeping a draft per replay", () => {
  it("keys on the game the form was opened for", () => {
    expect(reviewKey(draft({ replayId: 5, replayLink: "x" }))).toBe("id:5");
    expect(reviewKey(draft({ replayLink: " https://a " }))).toBe("link:https://a");
    expect(reviewKey(draft({ replayFile: "f.fafreplay" }))).toBe("file:f.fafreplay");
    expect(reviewKey(draft())).toBe("blank");
  });

  it("brings a kept draft back and lets it go on request", () => {
    const written = draft({ goal: "my eco falls apart at minute five" });
    keepReview("id:99", written);
    expect(keptReview("id:99")).toBe(written);
    forgetReview("id:99");
    expect(keptReview("id:99")).toBeNull();
  });

  it("treats the state's echo as the same draft and a change as a different one", () => {
    expect(sameReview(draft(), draft())).toBe(true);
    expect(sameReview(draft(), draft({ goal: "more" }))).toBe(false);
    expect(sameReview(null, draft())).toBe(false);
  });
});
