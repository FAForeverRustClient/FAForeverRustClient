import { native } from "../ipc/native";
import { validateHttpsUrl } from "./externalLinks";

// Presentation-only replacements: preserve the archived text and source data.
// The two original JPEGs still exist at their HTTPS URLs. The retired forum
// thread opens the archive's capture index without inventing a capture date.
const ARCHIVAL_LINKS: Readonly<Record<string, string>> = {
  "http://i.imgur.com/vJ17e3e.jpg": "https://i.imgur.com/vJ17e3e.jpg",
  "http://i.imgur.com/PDUhDx6.jpg": "https://i.imgur.com/PDUhDx6.jpg",
  "http://www.faforever.com/forums/viewtopic.php?f=36&t=1448":
    "https://web.archive.org/web/*/http://www.faforever.com/forums/viewtopic.php?f=36&t=1448",
};

export function changelogLinkTarget(url: string): string {
  return Object.prototype.hasOwnProperty.call(ARCHIVAL_LINKS, url) ? ARCHIVAL_LINKS[url] : url;
}

/** Call through ipc.run so rejected links and opener failures reach the banner. */
export async function openChangelogLink(url: string): Promise<void> {
  await native.openUrl(validateHttpsUrl(changelogLinkTarget(url)));
}
