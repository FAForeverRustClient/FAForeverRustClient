import { describe, expect, it } from "vitest";
import {
  EMBED_EXTERNAL_LINK_MESSAGE,
  externalUrlFromEmbedMessage,
} from "./embedSecurity";

describe("externalUrlFromEmbedMessage", () => {
  it("accepts an ordinary HTTPS target from the frame bridge", () => {
    expect(
      externalUrlFromEmbedMessage({
        type: EMBED_EXTERNAL_LINK_MESSAGE,
        url: "https://forum.faforever.com/topic/1/news",
      }),
    ).toBe("https://forum.faforever.com/topic/1/news");
  });

  it.each([
    null,
    {},
    { type: "other", url: "https://example.org" },
    { type: EMBED_EXTERNAL_LINK_MESSAGE, url: "http://example.org" },
    { type: EMBED_EXTERNAL_LINK_MESSAGE, url: "https://user@example.org" },
    { type: EMBED_EXTERNAL_LINK_MESSAGE, url: "https://example.org:8443" },
  ])("rejects malformed or unsafe messages", (message) => {
    expect(externalUrlFromEmbedMessage(message)).toBeNull();
  });
});
