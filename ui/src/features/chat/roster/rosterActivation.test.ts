import { describe, expect, it } from "vitest";
import { opensConversationOnClick } from "./UserList";

describe("opening a conversation from the roster", () => {
  it("opens on Enter or Space, which click with a count of 0", () => {
    expect(opensConversationOnClick(0)).toBe(true);
  });

  it("leaves pointer clicks to the double-click", () => {
    // The double-click handler opens it; opening on each of its two clicks
    // as well would send the commands three times.
    expect(opensConversationOnClick(1)).toBe(false);
    expect(opensConversationOnClick(2)).toBe(false);
  });
});
