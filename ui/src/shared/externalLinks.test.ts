import { describe, expect, it } from "vitest";
import { ACCOUNT_LINKS, optionalHttpsUrl, validateExternalUrl, validateHttpsUrl } from "./externalLinks";

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

  it("sends every account link to the user service rather than the website", () => {
    // The website's `/account/...` pages are gone. Registration and recovery
    // are reachable from the login screen before anyone is signed in, so a 404
    // there locks a new player out of the client entirely.
    expect(ACCOUNT_LINKS.create).toBe("https://user.faforever.com/register");
    expect(ACCOUNT_LINKS.recover).toBe("https://user.faforever.com/recover-account");
    expect(ACCOUNT_LINKS.rename).toBe("https://user.faforever.com/ucp/username");
    expect(ACCOUNT_LINKS.steam).toBe("https://user.faforever.com/ucp/linking");
  });
});
