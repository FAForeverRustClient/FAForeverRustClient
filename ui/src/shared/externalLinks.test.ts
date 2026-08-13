import { describe, expect, it } from "vitest";
import { optionalHttpsUrl, validateExternalUrl, validateHttpsUrl } from "./externalLinks";

describe("external link validation", () => {
  it("accepts HTTPS on an explicitly approved host", () => {
    expect(validateExternalUrl("https://faforever.com/account/register", ["faforever.com"]))
      .toBe("https://faforever.com/account/register");
  });

  it("rejects executable schemes, HTTP, and lookalike hosts", () => {
    for (const value of [
      "javascript:alert(1)",
      "http://faforever.com/account/register",
      "https://user@faforever.com/account/register",
      "https://faforever.com:444/account/register",
      "https://faforever.com.example.invalid/account/register",
    ]) {
      expect(() => validateExternalUrl(value, ["faforever.com"])).toThrow();
    }
  });

  it("allows a clan website only when it is ordinary HTTPS", () => {
    expect(validateHttpsUrl("https://example.org/clan")).toBe("https://example.org/clan");
    for (const value of [
      "javascript:alert(1)",
      "http://example.org/clan",
      "https://user@example.org/clan",
      "https://example.org:444/clan",
    ]) {
      expect(() => validateHttpsUrl(value)).toThrow();
    }
  });

  it("drops malformed optional API links without throwing during render", () => {
    expect(optionalHttpsUrl("https://example.org/notes")).toBe("https://example.org/notes");
    expect(optionalHttpsUrl("http://example.org/notes")).toBeNull();
    expect(optionalHttpsUrl(" ")).toBeNull();
  });
});
