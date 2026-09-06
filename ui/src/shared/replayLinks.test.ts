import { describe, expect, it } from "vitest";

import { onlineReplayLink, replayUidFromLink } from "./replayLinks";

describe("replayUidFromLink", () => {
  it("reads back what onlineReplayLink writes", () => {
    expect(replayUidFromLink(onlineReplayLink(19639494))).toBe(19639494);
    expect(replayUidFromLink("http://replay.faforever.com/18337693")).toBe(18337693);
    // A trailing slash is how a link ends up written by hand.
    expect(replayUidFromLink("https://replay.faforever.com/123/")).toBe(123);
    expect(replayUidFromLink("  https://replay.faforever.com/123  ")).toBe(123);
  });

  it("refuses anything that is not one, so it stays a link", () => {
    // This decides which addresses the client acts on itself rather than
    // opening, and the addresses come out of a document fetched from a
    // repository. A host that merely starts or ends with the right letters is
    // somebody else's host.
    expect(replayUidFromLink("https://replay.faforever.com.example.invalid/1")).toBeNull();
    expect(replayUidFromLink("https://evil.invalid/replay.faforever.com/1")).toBeNull();
    expect(replayUidFromLink("https://notreplay.faforever.com/1")).toBeNull();
    expect(replayUidFromLink("https://replay.faforever.com/1/extra")).toBeNull();
    expect(replayUidFromLink("https://replay.faforever.com/")).toBeNull();
    expect(replayUidFromLink("https://replay.faforever.com/abc")).toBeNull();
    // Not a game id: zero and negatives address nothing, and a number past
    // the safe integer range would have been rounded on the way in.
    expect(replayUidFromLink("https://replay.faforever.com/0")).toBeNull();
    expect(replayUidFromLink("https://forum.faforever.com/topic/1")).toBeNull();
    expect(replayUidFromLink("")).toBeNull();
  });
});
