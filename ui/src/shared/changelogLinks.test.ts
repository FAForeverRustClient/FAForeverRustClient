import { beforeEach, expect, it, vi } from "vitest";
import { changelogLinkTarget, openChangelogLink } from "./changelogLinks";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ipc/native", () => ({ native: { openUrl } }));
beforeEach(() => vi.clearAllMocks());

it.each([
  ["http://i.imgur.com/vJ17e3e.jpg", "https://i.imgur.com/vJ17e3e.jpg"],
  ["http://i.imgur.com/PDUhDx6.jpg", "https://i.imgur.com/PDUhDx6.jpg"],
  ["http://www.faforever.com/forums/viewtopic.php?f=36&t=1448",
    "https://web.archive.org/web/*/http://www.faforever.com/forums/viewtopic.php?f=36&t=1448"],
])("opens the known archived link %s over HTTPS", async (original, target) => {
  expect(changelogLinkTarget(original)).toBe(target);
  await openChangelogLink(original);
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(target);
});

it("keeps ordinary HTTPS citations intact", async () => {
  const url = "https://github.com/FAForever/fa/pull/6481";
  await openChangelogLink(url);
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
});

it.each([
  "http://i.imgur.com.evil.invalid/vJ17e3e.jpg",
  "http://i.imgur.com/vJ17e3e.jpg?unverified=1",
  "http://example.invalid/unverified",
  "javascript:alert(1)",
  "file:///untrusted",
  "https://user:password@example.invalid/",
  "https://example.invalid:8443/",
])("rejects unsafe or unverified targets without calling the opener: %s", async url => {
  await expect(openChangelogLink(url)).rejects.toThrow();
  expect(openUrl).not.toHaveBeenCalled();
});

it("propagates an opener failure for the shared error banner", async () => {
  openUrl.mockRejectedValueOnce(new Error("opener unavailable"));
  await expect(openChangelogLink("https://github.com/FAForever/fa/pull/6481")).rejects.toThrow("opener unavailable");
});
