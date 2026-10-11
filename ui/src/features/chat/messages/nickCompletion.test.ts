import { describe, expect, it } from "vitest";
import { tabCompletion } from "./nickCompletion";

const NICKS = ["Seraphim", "Sera", "Aeon", "cybran"];

describe("Tab in the composer", () => {
  it("lets focus leave an empty line", () => {
    // The report: Tab was swallowed unconditionally, so the keyboard could
    // never reach the emoji picker or the send button.
    expect(tabCompletion("", NICKS, null, false)).toBeNull();
    expect(tabCompletion("", NICKS, null, true)).toBeNull();
  });

  it("lets focus leave when the last word matches nobody", () => {
    expect(tabCompletion("hello there", NICKS, null, false)).toBeNull();
    // A trailing space means no word is being typed at all.
    expect(tabCompletion("hello Ser ", NICKS, null, false)).toBeNull();
  });

  it("completes the word being typed, case-insensitively, sorted", () => {
    const outcome = tabCompletion("hi ser", NICKS, null, false);
    expect(outcome?.text).toBe("hi Sera");
    expect(outcome?.completion).toEqual({ prefix: "hi ", matches: ["Sera", "Seraphim"], index: 0 });
  });

  it("cycles an active run both ways", () => {
    const active = { prefix: "hi ", matches: ["Sera", "Seraphim"], index: 0 };
    expect(tabCompletion("hi Sera", NICKS, active, false)?.text).toBe("hi Seraphim");
    expect(tabCompletion("hi Sera", NICKS, active, true)?.text).toBe("hi Seraphim");
    const second = { ...active, index: 1 };
    expect(tabCompletion("hi Seraphim", NICKS, second, false)?.text).toBe("hi Sera");
    expect(tabCompletion("hi Seraphim", NICKS, second, true)?.text).toBe("hi Sera");
  });

  it("never starts a completion on Shift+Tab, which is how focus goes back", () => {
    expect(tabCompletion("hi ser", NICKS, null, true)).toBeNull();
  });

  it("moves on once the only candidate is in place", () => {
    const active = { prefix: "", matches: ["Aeon"], index: 0 };
    expect(tabCompletion("Aeon", NICKS, active, false)).toBeNull();
    // Typed out in full by hand: nothing to complete either.
    expect(tabCompletion("Aeon", NICKS, null, false)).toBeNull();
  });
});
