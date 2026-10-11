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
    expect(outcome?.completion).toEqual({ prefix: "hi ", suffix: "", matches: ["Sera", "Seraphim"], index: 0 });
  });

  it("cycles an active run both ways", () => {
    const active = { prefix: "hi ", suffix: "", matches: ["Sera", "Seraphim"], index: 0 };
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
    const active = { prefix: "", suffix: "", matches: ["Aeon"], index: 0 };
    expect(tabCompletion("Aeon", NICKS, active, false)).toBeNull();
    // Typed out in full by hand: nothing to complete either.
    expect(tabCompletion("Aeon", NICKS, null, false)).toBeNull();
  });
});


describe("nickname completion at the caret", () => {
  it("preserves the suffix while cycling in the middle of a line", () => {
    const first = tabCompletion("hi ser, welcome", NICKS, null, false, { start: 6, end: 6 })!;
    expect(first.text).toBe("hi Sera, welcome");
    expect(first.caret).toBe(7);
    const next = tabCompletion(first.text, NICKS, first.completion, false, { start: first.caret, end: first.caret })!;
    expect(next.text).toBe("hi Seraphim, welcome");
    expect(next.caret).toBe(11);
    const back = tabCompletion(next.text, NICKS, next.completion, true, { start: next.caret, end: next.caret })!;
    expect(back.text).toBe(first.text);
  });

  it("starts a new run at the new caret rather than cycling the previous word", () => {
    const first = tabCompletion("Ae ser", NICKS, null, false)!;
    expect(tabCompletion(first.text, NICKS, first.completion, false, { start: 2, end: 2 })?.text).toBe("Aeon Sera");
  });

  it("leaves selected text and an empty word alone", () => {
    expect(tabCompletion("Ae ser", NICKS, null, false, { start: 3, end: 6 })).toBeNull();
    expect(tabCompletion("Ae ser", NICKS, null, false, { start: 3, end: 3 })).toBeNull();
    expect(tabCompletion("ser", NICKS, null, false, { start: 0, end: 0 })).toBeNull();
  });

  it("recognises whitespace and uses the input's UTF-16 caret offsets", () => {
    const first = tabCompletion("😀\tser afterwards", NICKS, null, false, { start: 6, end: 6 })!;
    expect(first.text).toBe("😀\tSera afterwards");
    expect(first.caret).toBe(7);
  });
});
