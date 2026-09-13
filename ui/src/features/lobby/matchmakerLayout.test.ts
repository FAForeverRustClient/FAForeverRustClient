import { describe, expect, it } from "vitest";

import { MAX_PARTY_CHAT_PX, MIN_PARTY_CHAT_PX } from "../../shared/browsingPreferences";
import {
  DEFAULT_PARTY_CHAT_WIDTH,
  partyChatWidth,
  withPartyChatResized,
} from "./matchmakerLayout";

describe("the party chat's width", () => {
  it("is the designed one until somebody drags it", () => {
    expect(partyChatWidth(0)).toBe(DEFAULT_PARTY_CHAT_WIDTH);
    expect(partyChatWidth(undefined)).toBe(DEFAULT_PARTY_CHAT_WIDTH);
  });

  it("keeps a stored width, and bounds one a settings file made up", () => {
    expect(partyChatWidth(520)).toBe(520);
    expect(partyChatWidth(10)).toBe(MIN_PARTY_CHAT_PX);
    expect(partyChatWidth(10_000)).toBe(MAX_PARTY_CHAT_PX);
  });
});

describe("dragging the divider", () => {
  it("widens the rail when the handle moves left", () => {
    expect(withPartyChatResized(400, -60)).toBe(460);
    expect(withPartyChatResized(400, 60)).toBe(340);
  });

  it("stops at the bounds rather than collapsing the rail or the queues", () => {
    expect(withPartyChatResized(MIN_PARTY_CHAT_PX, 500)).toBe(MIN_PARTY_CHAT_PX);
    expect(withPartyChatResized(MAX_PARTY_CHAT_PX, -500)).toBe(MAX_PARTY_CHAT_PX);
  });
});
