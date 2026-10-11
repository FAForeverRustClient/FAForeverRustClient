import { describe, expect, it } from "vitest";
import { messageLogLiveness } from "./MessageList";

describe("the scrollback as a live log", () => {
  it("announces new lines politely", () => {
    expect(messageLogLiveness(false, false)).toBe("polite");
  });

  it("stays quiet while a search swaps the list for its matches", () => {
    expect(messageLogLiveness(true, false)).toBe("off");
  });

  it("stays quiet while older history is prepended", () => {
    expect(messageLogLiveness(false, true)).toBe("off");
  });
});
