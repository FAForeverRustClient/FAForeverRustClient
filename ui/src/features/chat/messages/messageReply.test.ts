import { describe, expect, it } from "vitest";
import { repliesOnRightClick } from "./MessageList";

describe("replying by right-click", () => {
  it("answers an ordinary line", () => {
    // The report: the only way to quote something was the button at the far
    // edge of the pane, two hover targets away from the line it acts on.
    expect(repliesOnRightClick("message", "abc123", true)).toBe(true);
    expect(repliesOnRightClick("action", "abc123", true)).toBe(true);
  });

  it("leaves the client's own commentary alone", () => {
    // Info and error lines are the client talking, not somebody in the
    // channel. There is nobody to answer and no reply button on them either.
    expect(repliesOnRightClick("info", "abc123", true)).toBe(false);
    expect(repliesOnRightClick("error", "abc123", true)).toBe(false);
  });

  it("needs a msgid, which is what a reply points at", () => {
    expect(repliesOnRightClick("message", undefined, true)).toBe(false);
    expect(repliesOnRightClick("message", "", true)).toBe(false);
  });

  it("stays out of the way where replying is not offered at all", () => {
    expect(repliesOnRightClick("message", "abc123", false)).toBe(false);
  });
});
