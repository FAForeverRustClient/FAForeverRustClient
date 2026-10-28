// The link directory: every FAF site worth knowing about, in one list.
//
// Held here as data rather than fetched, and that is the decision worth
// explaining. Sheppy's community hub (`faf-hub.services.atlantishq.de`) is the
// same list on a web page, and integrating *it* was the first idea on the
// issue. It was dropped for the reason Nuggets gave there: this is a page of
// links, so pulling it over the network would mean the client fetching a
// document whose entire content is addresses it is then willing to open. A
// hardcoded list is a smaller attack surface, works offline, and is a one-line
// pull request when somebody launches something new.
//
// The hub itself is not one of the entries. Every destination it lists is in
// here, so linking to it would be linking to a longer way round to this page.
// The two it lists that are missing are deliberate: FAF's unit database is a
// tab of this client already, and the wiki's beginner guide is a page of the
// wiki, which is the second entry below.
//
// Every entry says whether FAF runs it or somebody else does, and that is all
// it says. The hints used to end in "by Vindex", "by Sheppy", "by Nuggets":
// naming the person who runs a site reads as an endorsement of that person,
// and it is not what the reader of this page needs. What they need before
// clicking is whether they are leaving FAF, so a row FAF runs carries an
// "Official" tag, and every row names the host it opens in its tooltip. The
// people are thanked at the bottom of the page instead.

import type { IconName } from "../../design-system/Icon";
import type { LiveStream } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";

/**
 * Who runs a destination. An `official` row carries a tag saying so; a
 * `community` one carries none, and its tooltip names the host it opens and
 * that FAF does not run it.
 *
 * `community` is deliberately not "a name we know": see the note above.
 */
export type LinkOrigin = "official" | "community";

/**
 * The groups, in the order they are drawn.
 */
export type LinkSection = "play" | "watch";

export const LINK_SECTIONS: LinkSection[] = ["play", "watch"];

export interface DirectoryLink {
  /** Stable id, used as the React key and in tests. */
  id: string;
  /**
   * The glyph on the card. What the page is scanned by: with one "external"
   * arrow on every row, Discord, the wiki and Twitch looked the same.
   */
  icon: IconName;
  name: MessageKey;
  hint: MessageKey;
  href: string;
  origin: LinkOrigin;
  section: LinkSection;
  /**
   * The streaming platform's login for this destination, when it has one.
   *
   * Only here so a card can be marked live. Absent on everything the client
   * cannot be told the broadcast state of, which is every YouTube channel and
   * every entry that is not a stream: see `infra::streams` for why Twitch is the
   * only one, and note that a channel is only ever reported live if the
   * deployment's `FAF_TWITCH_CHANNELS` includes it.
   */
  channel?: string;
}

/**
 * The directory.
 *
 * Only destinations FAF runs itself (#651): the third-party sites and the
 * platforms' game pages were taken out, so nothing here leaves FAF's hands.
 * The order within a section is the maintainers' choice: FAF's site, Discord,
 * wiki and forum first, then the tournaments and FAF Daily.
 */
export const DIRECTORY: readonly DirectoryLink[] = [
  {
    id: "faforever",
    icon: "globe",
    name: "links.entry.website",
    // Deliberately not "news, leaderboards and the vaults", which is what this
    // said first and is wrong on all three counts: the site's news is out of
    // date, and its map and mod pages are not where anybody browses either.
    // What it is good for is being the first address a player who has never run
    // FAF is given.
    hint: "links.entry.websiteHint",
    href: "https://www.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "discord",
    icon: "discord",
    name: "links.entry.discord",
    hint: "links.entry.discordHint",
    href: "https://discord.gg/fQxrjwru6E",
    origin: "official",
    section: "play",
  },
  {
    id: "wiki",
    icon: "book",
    name: "links.entry.wiki",
    hint: "links.entry.wikiHint",
    href: "https://wiki.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "forum",
    icon: "chat",
    name: "links.entry.forum",
    hint: "links.entry.forumHint",
    href: "https://forum.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "tournaments",
    icon: "trophy",
    name: "links.entry.tournaments",
    hint: "links.entry.tournamentsHint",
    href: "https://tournaments.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    // Back since it moved to FAF's own host (#651); it left with the other
    // third-party sites while it lived on doodlepros.com.
    id: "daily",
    icon: "calendar",
    name: "links.entry.daily",
    hint: "links.entry.dailyHint",
    href: "https://daily.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "twitch",
    icon: "twitch",
    name: "links.entry.twitch",
    hint: "links.entry.twitchHint",
    href: "https://www.twitch.tv/faflive",
    origin: "official",
    section: "watch",
    channel: "faflive",
  },
  {
    id: "youtube",
    icon: "youtube",
    name: "links.entry.youtube",
    hint: "links.entry.youtubeHint",
    href: "https://www.youtube.com/c/ForgedAllianceForever",
    origin: "official",
    section: "watch",
  },
];

/**
 * The entries of one section, in directory order.
 *
 * There used to be an origin filter as well (All / Official / External). It
 * was taken out: with seventeen entries in four cards the whole directory fits
 * on one screen, and the Official tag already says what the filter did.
 */
export function sectionLinks(section: LinkSection): DirectoryLink[] {
  return DIRECTORY.filter((link) => link.section === section);
}

/**
 * The address a card leads to, as a reader says it: the host without `www.`.
 *
 * Drawn under every card. It answers "where does this take me" literally,
 * which a chip saying "External" only answered in general.
 */
export function displayHost(href: string): string {
  return new URL(href).hostname.replace(/^www\./, "");
}

/**
 * The live broadcast on a card's channel, if there is one.
 *
 * Twin of `StreamsState::live_channel`: matched on the login rather than the
 * URL, because the URL is how a human wrote it and the login is what the
 * platform answers with.
 */
export function liveStreamFor(
  link: DirectoryLink,
  live: readonly LiveStream[],
): LiveStream | null {
  const channel = link.channel?.trim().toLocaleLowerCase();
  if (!channel) return null;
  return live.find((stream) => stream.channel.trim().toLocaleLowerCase() === channel) ?? null;
}
